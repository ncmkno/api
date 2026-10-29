import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { ConfigError, dailyBudget, projectDir, tcpPort } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { startListeners } from '../src/listeners.ts';

const HOUR = 3_600_000;
const DAY1 = Date.UTC(2026, 0, 1);

type Raw = Record<string, unknown>;
type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string; json: any };
type RequestOptions = { host?: string | null; body?: string; headers?: Record<string, string> };
type Stack = {
  db: DatabaseSync;
  socket: string;
  port: number; // the TCP port the listener got; 0 when there is none
  tcpPort: number | null;
  viaSocket: (method: string, path: string, body?: string) => Promise<Reply>;
  // host: the Host header to send (default: the real one); null sends none
  viaTcp: (method: string, path: string, options?: RequestOptions) => Promise<Reply>;
  post: (events: Raw[]) => Promise<Reply>;
  count: (table: string) => number;
};

// ---- Harness: the real listeners, a Unix socket in a temp dir and TCP on an ephemeral loopback port ----

function request(target: http.RequestOptions, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (part: Buffer) => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withStack(run: (stack: Stack) => Promise<void>, port: number | null = 0): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-tcp-'));
  const socket = path.join(scratch, 's.sock');
  const distDir = path.join(scratch, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>fixture dashboard</title>');
  fs.writeFileSync(path.join(distDir, 'assets', 'app-1.js'), 'console.log("app")');
  const db = openDb(':memory:');
  const listeners = await startListeners(db, { socket, port, distDir });
  const boundPort = listeners.tcpPort ?? 0;

  const viaSocket: Stack['viaSocket'] = (method, requestPath, body) =>
    request({ socketPath: socket, method, path: requestPath }, body);
  try {
    await run({
      db,
      socket,
      port: boundPort,
      tcpPort: listeners.tcpPort,
      viaSocket,
      viaTcp: (method, requestPath, { host, body, headers } = {}) =>
        request(
          {
            host: '127.0.0.1',
            port: boundPort,
            method,
            path: requestPath,
            ...(host === null ? { setHost: false } : {}),
            headers: { ...(typeof host === 'string' ? { Host: host } : {}), ...headers },
          },
          body,
        ),
      post: (events) => viaSocket('POST', '/events', JSON.stringify({ events })),
      count: (table) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    });
  } finally {
    await listeners.close();
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- Event builders ---------------------------------------------------------------------------------

let nextId = 0;
const id = () => `tcp-ev-${++nextId}`;

const sessionEvent = (session: string, ts: number, cwd: string): Raw => ({ id: id(), v: 1, type: 'session', session, ts, state: 'start', cwd });
const usage = (session: string, ts: number): Raw => ({
  id: id(), v: 1, type: 'usage', session, ts, agent: 'main', model: 'm', input: 10, output: 5, cacheRead: 100, cacheWrite: 1, costUsd: 0.5,
});
const tool = (session: string, ts: number): Raw => ({ id: id(), v: 1, type: 'tool', session, ts, agent: 'main', tool: 'Bash' });

const fixtureEvents = (): Raw[] => [
  sessionEvent('sess-a', DAY1, '/work/a'),
  usage('sess-a', DAY1 + HOUR),
  tool('sess-a', DAY1 + HOUR),
  usage('sess-b', DAY1 + 2 * HOUR),
];

const otherPort = (port: number) => (port === 65535 ? 65534 : port + 1);

// ---- The TCP listener serves the dashboard and the read API -------------------------------------------

describe('TCP listener: what it serves', () => {
  test('serves /health, the sessions list, a session detail and the summary', () =>
    withStack(async (stack) => {
      assert.equal((await stack.post(fixtureEvents())).status, 201);

      const health = await stack.viaTcp('GET', '/health');
      assert.equal(health.status, 200);
      assert.equal(health.text, 'ok');

      const sessions = await stack.viaTcp('GET', '/api/sessions');
      assert.equal(sessions.status, 200);
      assert.deepEqual(sessions.json.map((row: Raw) => row.session), ['sess-b', 'sess-a']);

      const detail = await stack.viaTcp('GET', '/api/sessions/sess-a');
      assert.equal(detail.status, 200);
      assert.equal(detail.json.cwd, '/work/a');
      assert.deepEqual(detail.json.tools, [{ tool: 'Bash', count: 1 }]);
      assert.equal((await stack.viaTcp('GET', '/api/sessions/nope')).status, 404);

      const summary = await stack.viaTcp('GET', '/api/summary');
      assert.equal(summary.status, 200);
      assert.deepEqual(summary.json.byDay.map((row: Raw) => [row.day, row.requests, row.tools]), [['2026-01-01', 2, 1]]);
    }));

  test('what the socket wrote is what TCP reads, byte for byte', () =>
    withStack(async (stack) => {
      await stack.post(fixtureEvents());
      for (const route of ['/api/sessions', '/api/sessions/sess-a', '/api/summary', '/health']) {
        const overSocket = await stack.viaSocket('GET', route);
        const overTcp = await stack.viaTcp('GET', route);
        assert.equal(overTcp.status, 200, route);
        assert.equal(overTcp.text, overSocket.text, route);
      }
    }));

  test('serves the dashboard at / and its files, and the placeholder when there is no build', () =>
    withStack(async (stack) => {
      const index = await stack.viaTcp('GET', '/');
      assert.equal(index.status, 200);
      assert.match(index.text, /fixture dashboard/);
      assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
      const script = await stack.viaTcp('GET', '/assets/app-1.js');
      assert.equal(script.status, 200);
      assert.equal(script.text, 'console.log("app")');
      assert.equal((await stack.viaTcp('GET', '/assets/missing.js')).status, 404);
    }));

  test('answers HEAD for the same routes, with the headers and no body', () =>
    withStack(async (stack) => {
      await stack.post(fixtureEvents());
      for (const route of ['/health', '/api/sessions', '/api/sessions/sess-a', '/api/summary', '/', '/assets/app-1.js']) {
        const head = await stack.viaTcp('HEAD', route);
        const get = await stack.viaTcp('GET', route);
        assert.equal(head.status, 200, route);
        assert.equal(head.text, '', route);
        assert.equal(head.headers['content-type'], get.headers['content-type'], route);
        assert.equal(head.headers['cache-control'], get.headers['cache-control'], route);
      }
      assert.equal((await stack.viaTcp('HEAD', '/events')).status, 404);
      assert.equal((await stack.viaTcp('HEAD', '/nope')).status, 404);
    }));
});

describe('TCP listener: what it refuses', () => {
  test('POST /events is 404 and stores nothing; ingest works on the socket only', () =>
    withStack(async (stack) => {
      const body = JSON.stringify({ events: fixtureEvents() });
      const overTcp = await stack.viaTcp('POST', '/events', { body });
      assert.equal(overTcp.status, 404);
      assert.equal(typeof overTcp.json.error, 'string');
      assert.equal(stack.count('usage_event'), 0);
      assert.equal(stack.count('session'), 0);

      const overSocket = await stack.viaSocket('POST', '/events', body);
      assert.equal(overSocket.status, 201);
      assert.deepEqual(overSocket.json, { accepted: 4, duplicates: 0 });
      assert.equal(stack.count('usage_event'), 2);
    }));

  test('GET /events, an unknown path and every other method are 404', () =>
    withStack(async (stack) => {
      const cases: [string, string][] = [
        ['GET', '/events'],
        ['GET', '/events/'],
        ['GET', '/nope'],
        ['GET', '/api'],
        ['GET', '/api/summary/extra'],
        ['GET', '/session/abc'],
        ['PUT', '/events'],
        ['DELETE', '/events'],
        ['POST', '/health'],
        ['POST', '/api/sessions'],
        ['DELETE', '/api/sessions/sess-a'],
        ['PUT', '/api/summary'],
        ['POST', '/'],
        ['POST', '/assets/app-1.js'],
        ['OPTIONS', '/api/sessions'],
        ['OPTIONS', '/events'],
      ];
      for (const [method, route] of cases) {
        const reply = await stack.viaTcp(method, route);
        assert.equal(reply.status, 404, `${method} ${route}`);
        assert.equal(reply.headers.allow, undefined, `${method} ${route}`);
      }
    }));

  test('a wrong Host is 421 with a short plain-text body, whatever the request', () =>
    withStack(async (stack) => {
      const wrong: (string | null)[] = [
        `evil.example:${stack.port}`,
        'evil.example',
        '127.0.0.1', // no port
        'localhost',
        `127.0.0.1:${otherPort(stack.port)}`,
        `localhost:${otherPort(stack.port)}`,
        `127.0.0.1.evil.example:${stack.port}`,
        `evil.example:${stack.port}@127.0.0.1:${stack.port}`,
        `[::1]:${stack.port}`,
        null, // no Host header at all
      ];
      for (const host of wrong) {
        for (const [method, route] of [['GET', '/health'], ['GET', '/api/sessions'], ['HEAD', '/'], ['POST', '/events'], ['GET', '/nope']]) {
          const reply = await stack.viaTcp(method, route, { host, body: method === 'POST' ? '{}' : undefined });
          assert.equal(reply.status, 421, `${method} ${route} Host ${JSON.stringify(host)}`);
          assert.match(reply.headers['content-type'] ?? '', /^text\/plain/);
          if (method !== 'HEAD') assert.match(reply.text, /^421 Misdirected Request\n$/);
        }
      }
    }));

  test('an empty Host, or none on a raw HTTP/1.1 request, is 421', () =>
    withStack(async (stack) => {
      for (const head of ['GET /health HTTP/1.1\r\nHost:\r\n', 'GET /health HTTP/1.1\r\n', 'GET /health HTTP/1.0\r\n']) {
        const reply = await rawHttp(stack.port, `${head}Connection: close\r\n\r\n`);
        assert.match(reply, /^HTTP\/1\.1 421 /, JSON.stringify(head));
      }
    }));

  test('Host 127.0.0.1:<port> and localhost:<port> pass, the name in any letter case', () =>
    withStack(async (stack) => {
      for (const host of [`127.0.0.1:${stack.port}`, `localhost:${stack.port}`, `LocalHost:${stack.port}`, `LOCALHOST:${stack.port}`]) {
        for (const route of ['/health', '/api/sessions', '/api/summary', '/']) {
          assert.equal((await stack.viaTcp('GET', route, { host })).status, 200, `${route} Host ${host}`);
        }
      }
    }));

  test('no reply carries a CORS header', () =>
    withStack(async (stack) => {
      await stack.post(fixtureEvents());
      const replies = [
        await stack.viaTcp('GET', '/health', { host: 'evil.example' }),
        await stack.viaTcp('GET', '/api/sessions'),
        await stack.viaTcp('GET', '/api/sessions/nope'),
        await stack.viaTcp('GET', '/'),
        await stack.viaTcp('POST', '/events', { body: '{}' }),
        await stack.viaTcp('OPTIONS', '/api/sessions'),
        await stack.viaSocket('GET', '/api/sessions'),
        await stack.viaSocket('POST', '/events', '{}'),
      ];
      for (const reply of replies) {
        const cors = Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'));
        assert.deepEqual(cors, [], `status ${reply.status}`);
      }
    }));
});

// ---- Cross-site requests ----------------------------------------------------------------------------

describe('TCP listener: cross-site requests', () => {
  const SITES = ['cross-site', 'same-site'];

  test('cross-site and same-site requests are 403 with a short plain-text body, whatever the route or method', () =>
    withStack(async (stack) => {
      await stack.post(fixtureEvents());
      const requests: [string, string, string?][] = [
        ['GET', '/health'],
        ['GET', '/api/sessions'],
        ['GET', '/api/sessions/sess-a'],
        ['GET', '/api/summary'],
        ['GET', '/assets/app-1.js'],
        ['GET', '/index.html'],
        ['GET', '/nope'],
        ['HEAD', '/'],
        ['POST', '/', '{}'],
        ['POST', '/events', JSON.stringify({ events: fixtureEvents() })],
      ];
      for (const site of SITES) {
        for (const [method, route, body] of requests) {
          const reply = await stack.viaTcp(method, route, { body, headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'cors' } });
          const label = `${site} ${method} ${route}`;
          assert.equal(reply.status, 403, label);
          assert.match(reply.headers['content-type'] ?? '', /^text\/plain/, label);
          assert.equal(reply.headers['cache-control'], 'no-store', label);
          if (method !== 'HEAD') assert.equal(reply.text, '403 Forbidden\n', label); // not a byte of the data
        }
      }
      assert.equal(stack.count('usage_event'), 2); // only the two from the setup: the refused POSTs stored nothing
    }));

  test('the one exception is a GET document load of /: a link into the dashboard from another site works', () =>
    withStack(async (stack) => {
      for (const site of SITES) {
        for (const route of ['/', '/?from=mail', '/?']) {
          const reply = await stack.viaTcp('GET', route, { headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
          assert.equal(reply.status, 200, `${site} ${route}`);
          assert.match(reply.text, /fixture dashboard/, `${site} ${route}`);
        }
      }
    }));

  test('a navigation is not enough: other paths, other methods and other modes are still 403', () =>
    withStack(async (stack) => {
      const refused: [string, string, string | undefined][] = [
        ['GET', '/api/sessions', 'navigate'],
        ['GET', '/api/summary', 'navigate'],
        ['GET', '/health', 'navigate'],
        ['GET', '/index.html', 'navigate'],
        ['GET', '/assets/app-1.js', 'navigate'],
        ['GET', '//', 'navigate'],
        ['HEAD', '/', 'navigate'],
        ['POST', '/', 'navigate'], // a cross-site form post
        ['GET', '/', 'no-cors'], // <img>, <script>, <link>
        ['GET', '/', 'cors'], // fetch()
        ['GET', '/', 'websocket'],
        ['GET', '/', 'nested-navigate'], // <iframe>
        ['GET', '/', undefined], // no Sec-Fetch-Mode at all
      ];
      for (const site of SITES) {
        for (const [method, route, mode] of refused) {
          const headers: Record<string, string> = { 'Sec-Fetch-Site': site, ...(mode === undefined ? {} : { 'Sec-Fetch-Mode': mode }) };
          const reply = await stack.viaTcp(method, route, { headers, body: method === 'POST' ? '{}' : undefined });
          assert.equal(reply.status, 403, `${site} ${method} ${route} mode ${mode}`);
        }
      }
    }));

  test('a request without Sec-Fetch-Site, same-origin or none passes untouched', () =>
    withStack(async (stack) => {
      await stack.post(fixtureEvents());
      const allowed: (Record<string, string> | undefined)[] = [
        undefined,
        {},
        { 'Sec-Fetch-Site': 'same-origin' },
        { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' },
        { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' },
        { 'Sec-Fetch-Site': 'none' },
        { 'Sec-Fetch-Mode': 'no-cors' }, // no Site header: not a browser that can be judged
      ];
      for (const headers of allowed) {
        for (const route of ['/', '/health', '/api/sessions', '/api/sessions/sess-a', '/api/summary', '/assets/app-1.js']) {
          const reply = await stack.viaTcp('GET', route, { headers });
          assert.equal(reply.status, 200, `${route} ${JSON.stringify(headers)}`);
        }
        // the usual TCP behaviour is unchanged: ingest is still not served here
        assert.equal((await stack.viaTcp('POST', '/events', { headers, body: '{}' })).status, 404, JSON.stringify(headers));
      }
    }));

  test('the Host check comes first, and the socket has no cross-site check', () =>
    withStack(async (stack) => {
      const both = await stack.viaTcp('GET', '/health', { host: 'evil.example', headers: { 'Sec-Fetch-Site': 'cross-site' } });
      assert.equal(both.status, 421);
      for (const site of SITES) {
        const reply = await request({ socketPath: stack.socket, path: '/api/sessions', headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors' } });
        assert.equal(reply.status, 200, site);
        assert.deepEqual(reply.json, []);
      }
    }));
});

// ---- Response headers -------------------------------------------------------------------------------

describe('response headers on both listeners', () => {
  test('nosniff, same-origin CORP and frame-ancestors none on every reply, the refusals included', () =>
    withStack(async (stack) => {
      await stack.post(fixtureEvents());
      const replies: [string, Reply][] = [
        ['tcp health', await stack.viaTcp('GET', '/health')],
        ['tcp sessions', await stack.viaTcp('GET', '/api/sessions')],
        ['tcp 404 json', await stack.viaTcp('GET', '/api/sessions/nope')],
        ['tcp 404 ingest', await stack.viaTcp('POST', '/events', { body: '{}' })],
        ['tcp index', await stack.viaTcp('GET', '/')],
        ['tcp asset', await stack.viaTcp('GET', '/assets/app-1.js')],
        ['tcp HEAD', await stack.viaTcp('HEAD', '/health')],
        ['tcp 421', await stack.viaTcp('GET', '/health', { host: 'evil.example' })],
        ['tcp 403', await stack.viaTcp('GET', '/api/sessions', { headers: { 'Sec-Fetch-Site': 'cross-site' } })],
        ['socket ingest', await stack.post(fixtureEvents())],
        ['socket 400', await stack.viaSocket('POST', '/events', '{}')],
        ['socket sessions', await stack.viaSocket('GET', '/api/sessions')],
        ['socket 405', await stack.viaSocket('GET', '/events')],
      ];
      for (const [name, reply] of replies) {
        assert.equal(reply.headers['x-content-type-options'], 'nosniff', name);
        assert.equal(reply.headers['cross-origin-resource-policy'], 'same-origin', name);
        assert.equal(reply.headers['content-security-policy'], "frame-ancestors 'none'", name);
      }
    }));
});

// ---- The socket is unchanged ------------------------------------------------------------------------

describe('Unix socket next to the TCP listener', () => {
  test('is owner-only, takes ingest (201) and has no Host check or read-only limit', () =>
    withStack(async (stack) => {
      assert.equal(fs.statSync(stack.socket).mode & 0o777, 0o600);
      const reply = await stack.post(fixtureEvents());
      assert.equal(reply.status, 201);
      assert.deepEqual(reply.json, { accepted: 4, duplicates: 0 });

      // existing behaviour: 405 for the wrong method on a known route, and any Host is fine
      assert.equal((await stack.viaSocket('GET', '/events')).status, 405);
      assert.equal((await stack.viaSocket('HEAD', '/health')).status, 405);
      const odd = await request({ socketPath: stack.socket, path: '/health', headers: { Host: 'evil.example' } });
      assert.equal(odd.status, 200);
    }));
});

// ---- Binding ----------------------------------------------------------------------------------------

describe('TCP binding', () => {
  test('port null: no TCP listener, the socket works as before', () =>
    withStack(async (stack) => {
      assert.equal(stack.tcpPort, null);
      assert.equal((await stack.post(fixtureEvents())).status, 201);
      assert.equal((await stack.viaSocket('GET', '/')).status, 200);
    }, null));

  test('port 0 binds an ephemeral port on 127.0.0.1 only', async (t) => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    await withStack(async (stack) => {
      assert.ok(stack.tcpPort !== null && stack.tcpPort > 0);
      await connects(stack.tcpPort, '127.0.0.1');
      if (external === undefined) return t.diagnostic('no non-loopback IPv4 address on this machine: all-interfaces check skipped');
      await assert.rejects(connects(stack.tcpPort, external), { code: 'ECONNREFUSED' });
    });
  });

  test('close() stops both listeners and removes the socket', async () => {
    let closedPort = 0;
    let closedSocket = '';
    await withStack(async (stack) => {
      closedPort = stack.port;
      closedSocket = stack.socket;
      assert.ok(fs.existsSync(stack.socket));
    });
    assert.ok(!fs.existsSync(closedSocket));
    await assert.rejects(connects(closedPort, '127.0.0.1'), { code: 'ECONNREFUSED' });
  });

  test('a port that is taken logs a warning naming it, and the socket keeps serving', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as net.AddressInfo).port;
    try {
      await withStack(async (stack) => {
        assert.equal(stack.tcpPort, null);
        assert.equal(warn.mock.callCount(), 1);
        const message = String(warn.mock.calls[0].arguments[0]);
        assert.match(message, new RegExp(`127\\.0\\.0\\.1:${taken}\\b`));
        assert.match(message, /EADDRINUSE/);

        assert.equal((await stack.post(fixtureEvents())).status, 201);
        assert.equal((await stack.viaSocket('GET', '/api/sessions')).json.length, 2);
      }, taken);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

// A request written by hand: node's own client fills in a Host when it is empty.
function rawHttp(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    socket.on('data', (part: Buffer) => parts.push(part));
    socket.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    socket.on('error', reject);
  });
}

function connects(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = net.connect(port, host);
    probe.once('connect', () => {
      probe.destroy();
      resolve();
    });
    probe.once('error', reject);
  });
}

// ---- USAGE_MONITOR_DAILY_BUDGET ---------------------------------------------------------------------

describe('dailyBudget (USAGE_MONITOR_DAILY_BUDGET)', () => {
  test('unset or empty means no budget', () => {
    assert.equal(dailyBudget({}), null);
    assert.equal(dailyBudget({ USAGE_MONITOR_DAILY_BUDGET: '' }), null);
  });

  test('takes a positive amount in USD, with or without cents', () => {
    assert.equal(dailyBudget({ USAGE_MONITOR_DAILY_BUDGET: '20' }), 20);
    assert.equal(dailyBudget({ USAGE_MONITOR_DAILY_BUDGET: '7.50' }), 7.5);
  });

  test('refuses anything else, naming the setting', () => {
    for (const bad of ['0', '-5', 'ten', '$20', '1e3', 'Infinity']) {
      assert.throws(() => dailyBudget({ USAGE_MONITOR_DAILY_BUDGET: bad }), (e: unknown) => e instanceof ConfigError && /USAGE_MONITOR_DAILY_BUDGET/.test(e.message));
    }
  });
});

// ---- USAGE_MONITOR_PORT -----------------------------------------------------------------------------

describe('tcpPort (USAGE_MONITOR_PORT)', () => {
  test('unset or empty means no TCP listener', () => {
    assert.equal(tcpPort({}), null);
    assert.equal(tcpPort({ USAGE_MONITOR_PORT: '' }), null);
  });

  test('an integer from 1 to 65535 is the port', () => {
    assert.equal(tcpPort({ USAGE_MONITOR_PORT: '1' }), 1);
    assert.equal(tcpPort({ USAGE_MONITOR_PORT: '7842' }), 7842);
    assert.equal(tcpPort({ USAGE_MONITOR_PORT: '65535' }), 65535);
  });

  test('anything else is a ConfigError naming the variable and the value, on one line', () => {
    for (const bad of ['0', '65536', '-1', '+80', 'abc', '78 42', ' 7842', '7842 ', '1.5', '1e3', '0x1F', '123456', ' ', '7842\n']) {
      assert.throws(
        () => tcpPort({ USAGE_MONITOR_PORT: bad }),
        (error: Error) => {
          assert.ok(error instanceof ConfigError, JSON.stringify(bad));
          assert.match(error.message, /^USAGE_MONITOR_PORT must be an integer from 1 to 65535, got /);
          assert.ok(!error.message.includes('\n'), JSON.stringify(bad));
          return true;
        },
        JSON.stringify(bad),
      );
    }
  });
});

describe('node src/server.ts with a bad USAGE_MONITOR_PORT', () => {
  test('exits 1 with a one-line message, before it opens the database or the socket', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-boot-'));
    try {
      for (const bad of ['abc', '0', '70000', '7842x']) {
        const run = spawnSync(process.execPath, [path.join(projectDir, 'src', 'server.ts')], {
          cwd: scratch,
          timeout: 20_000,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            USAGE_MONITOR_SOCKET: path.join(scratch, 's.sock'),
            USAGE_MONITOR_DB: path.join(scratch, 'usage.db'),
            USAGE_MONITOR_PORT: bad,
          },
        });
        assert.equal(run.status, 1, `${bad}: ${run.stderr}`);
        assert.equal(run.stdout, '');
        const message = run.stderr.split('\n').filter((line) => line.includes('USAGE_MONITOR_PORT'));
        assert.deepEqual(message, [`usage-monitor: USAGE_MONITOR_PORT must be an integer from 1 to 65535, got ${JSON.stringify(bad)}`]);
        assert.doesNotMatch(run.stderr, /\n\s+at /); // no stack trace
        assert.deepEqual(fs.readdirSync(scratch), []); // neither the database nor the socket was created
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('node src/server.ts with a bad socket setting', () => {
  // Starts the real entry point; a good setting would start a service, so every case here must exit 1 before listening.
  function boot(env: Record<string, string>, scratch: string) {
    return spawnSync(process.execPath, [path.join(projectDir, 'src', 'server.ts')], {
      cwd: scratch,
      timeout: 20_000,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, USAGE_MONITOR_DB: path.join(scratch, 'data', 'usage.db'), ...env },
    });
  }

  test('a socket directory others can write to: exit 1, one line, no database and no socket created', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-boot-'));
    try {
      const shared = path.join(scratch, 'shared');
      fs.mkdirSync(shared);
      for (const mode of [0o777, 0o770]) {
        fs.chmodSync(shared, mode);
        const run = boot({ USAGE_MONITOR_SOCKET: path.join(shared, 'usage-monitor.sock') }, scratch);
        assert.equal(run.status, 1, run.stderr);
        assert.equal(run.stdout, '');
        assert.equal(run.stderr.trimEnd().split('\n').length, 1, run.stderr);
        assert.match(run.stderr, new RegExp(`^usage-monitor: the socket directory ${shared} is owned by uid ${process.getuid!()} with mode ${mode.toString(8).padStart(4, '0')}; `));
        assert.match(run.stderr, /\$XDG_RUNTIME_DIR/);
        assert.doesNotMatch(run.stderr, /\n\s+at /); // no stack trace
        assert.deepEqual(fs.readdirSync(shared), []); // no socket file
        assert.ok(!fs.existsSync(path.join(scratch, 'data'))); // the database was not touched
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('no USAGE_MONITOR_SOCKET and no XDG_RUNTIME_DIR: exit 1 with the one-line message, not a stack trace', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-boot-'));
    try {
      const run = boot({}, scratch);
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr.trimEnd(), 'usage-monitor: Set USAGE_MONITOR_SOCKET, or XDG_RUNTIME_DIR for the default socket path');
      assert.deepEqual(fs.readdirSync(scratch), []);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
