import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.ts';
import { createHandler, SESSION_DETAIL_SQL, SESSION_LIST_SQL, type HandlerOptions } from '../src/routes.ts';

const HOUR = 3_600_000;
const DAY1 = Date.UTC(2026, 0, 1);
const DAY2 = Date.UTC(2026, 0, 2);
const ONE_MIB = 1024 * 1024;

type Raw = Record<string, unknown>;
type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string; json: any };
type Service = {
  db: DatabaseSync;
  distDir: string;
  scratch: string;
  send: (method: string, path: string, body?: string | string[]) => Promise<Reply>;
  post: (events: unknown) => Promise<Reply>;
  get: (path: string) => Promise<Reply>;
  count: (table: string) => number;
};

// ---- Harness: a real server on a Unix socket in a temp dir, an in-memory database ----------------

async function withService(run: (service: Service) => Promise<void>, options: HandlerOptions = {}): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-http-'));
  const socket = path.join(scratch, 's.sock');
  const distDir = path.join(scratch, 'dist'); // created by the tests that need a built dashboard
  const db = openDb(':memory:');
  const server = http.createServer(createHandler(db, { distDir, ...options }));
  const agent = new http.Agent({ keepAlive: true });
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  const send: Service['send'] = (method, requestPath, body) =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath: socket, method, path: requestPath, agent }, (res) => {
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
      // An array is sent as separate chunks, which makes the request chunked (no Content-Length).
      if (Array.isArray(body)) {
        body.forEach((part) => req.write(part));
        req.end();
      } else {
        req.end(body);
      }
    });

  try {
    await run({
      db,
      distDir,
      scratch,
      send,
      post: (events) => send('POST', '/events', JSON.stringify({ events })),
      get: (requestPath) => send('GET', requestPath),
      count: (table) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    });
  } finally {
    agent.destroy(); // the client goes first: a server that cuts a socket mid-flush makes the client's last write fail
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- Event builders ---------------------------------------------------------------------------------

let nextId = 0;
const id = () => `ev-${++nextId}`;

const usage = (sessionId: string, agent: string, model: string, ts: number, tokens: [number, number, number, number], costUsd: number | null, over: Raw = {}): Raw => ({
  id: id(), v: 1, type: 'usage', session: sessionId, ts, agent, model,
  input: tokens[0], output: tokens[1], cacheRead: tokens[2], cacheWrite: tokens[3], costUsd, ...over,
});
const tool = (sessionId: string, agent: string, name: string, ts: number, detail?: string): Raw => ({
  id: id(), v: 1, type: 'tool', session: sessionId, ts, agent, tool: name, ...(detail === undefined ? {} : { detail }),
});
const agentEvent = (sessionId: string, agent: string, ts: number, label: string, model?: string): Raw => ({
  id: id(), v: 1, type: 'agent', session: sessionId, ts, agent, label, ...(model === undefined ? {} : { model }),
});
const sessionEvent = (sessionId: string, ts: number, state: string, cwd?: string): Raw => ({
  id: id(), v: 1, type: 'session', session: sessionId, ts, state, ...(cwd === undefined ? {} : { cwd }),
});

// Session "sess-a" runs across two UTC days, "sess-b" starts on the second one.
// Hand-computed totals are in the read-route tests below.
function fixtureEvents(): Raw[] {
  return [
    sessionEvent('sess-a', DAY1 + 10 * HOUR, 'start', '/work/a'),
    usage('sess-a', 'main', 'm-big', DAY1 + 11 * HOUR, [100, 50, 1000, 10], 0.25),
    usage('sess-a', 'main', 'm-big', DAY1 + 12 * HOUR, [200, 20, 2000, 0], 0.5),
    agentEvent('sess-a', 'sub-1', DAY1 + 11.5 * HOUR, 'explore', 'm-small'),
    usage('sess-a', 'sub-1', 'm-small', DAY2 + HOUR, [10, 5, 100, 1], null),
    tool('sess-a', 'main', 'Bash', DAY1 + 11 * HOUR),
    tool('sess-a', 'main', 'Bash', DAY1 + 12 * HOUR),
    tool('sess-a', 'main', 'Read', DAY1 + 12 * HOUR),
    tool('sess-a', 'main', 'Edit', DAY1 + 12 * HOUR),
    tool('sess-a', 'sub-1', 'Read', DAY2 + HOUR),
    usage('sess-b', 'main', 'm-big', DAY2 + 5 * HOUR, [1, 1, 0, 0], 0.125),
    tool('sess-b', 'main', 'Edit', DAY2 + 5 * HOUR),
  ];
}

const tableCounts = (service: Service) =>
  ['session', 'agent', 'usage_event', 'tool_call', 'state_event'].map((table) => service.count(table));

// ---- Ingest -----------------------------------------------------------------------------------------

describe('POST /events', () => {
  test('stores a valid batch: 201 with accepted and no duplicates', () =>
    withService(async (service) => {
      const reply = await service.post(fixtureEvents());
      assert.equal(reply.status, 201);
      assert.deepEqual(reply.json, { accepted: 12, duplicates: 0 });
      assert.equal(service.count('usage_event'), 4);
      assert.equal(service.count('tool_call'), 6);
      assert.equal(service.count('session'), 2);
      assert.equal(service.count('agent'), 3); // sess-a main, sess-a sub-1, sess-b main
      assert.equal(reply.headers['cache-control'], 'no-store');
    }));

  test('resending a batch stores nothing new and reports every event as a duplicate', () =>
    withService(async (service) => {
      const events = fixtureEvents();
      await service.post(events);
      const countsBefore = tableCounts(service);
      const detailBefore = (await service.get('/api/sessions/sess-a')).json;

      const again = await service.post(events);
      assert.equal(again.status, 201);
      assert.deepEqual(again.json, { accepted: 0, duplicates: events.length });
      assert.deepEqual(tableCounts(service), countsBefore);
      assert.deepEqual((await service.get('/api/sessions/sess-a')).json, detailBefore);
    }));

  test('a batch that overlaps stored events counts only the repeats as duplicates', () =>
    withService(async (service) => {
      const first = usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 1);
      await service.post([first]);
      const reply = await service.post([first, usage('s', 'main', 'm', DAY1 + 1, [1, 1, 1, 1], 1)]);
      assert.deepEqual(reply.json, { accepted: 1, duplicates: 1 });
      assert.equal(service.count('usage_event'), 2);
    }));

  test('an id repeated inside one batch is stored once', () =>
    withService(async (service) => {
      const event = tool('s', 'main', 'Bash', DAY1);
      const reply = await service.post([event, event]);
      assert.deepEqual(reply.json, { accepted: 1, duplicates: 1 });
      assert.equal(service.count('tool_call'), 1);
    }));

  test('a batch with one invalid event is rejected whole: 400, nothing stored', () =>
    withService(async (service) => {
      const reply = await service.post([
        sessionEvent('s', DAY1, 'start', '/w'),
        usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 1),
        usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], -1),
      ]);
      assert.equal(reply.status, 400);
      assert.match(reply.json.error, /events\[2\]\.costUsd/);
      assert.deepEqual(tableCounts(service), [0, 0, 0, 0, 0]);
    }));

  test('a rejected batch can be fixed and resent', () =>
    withService(async (service) => {
      const good = usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 1);
      const bad = { ...good, id: 'other', input: -5 };
      assert.equal((await service.post([good, bad])).status, 400);
      assert.deepEqual((await service.post([good])).json, { accepted: 1, duplicates: 0 });
    }));

  test('400 for malformed JSON, an empty body and a body of the wrong shape', () =>
    withService(async (service) => {
      for (const body of ['{"events": [', '', 'null', '[]', '{"events": []}']) {
        const reply = await service.send('POST', '/events', body);
        assert.equal(reply.status, 400, `body ${JSON.stringify(body)}`);
        assert.equal(typeof reply.json.error, 'string');
      }
      assert.deepEqual(tableCounts(service), [0, 0, 0, 0, 0]);
    }));

  test('413 over 1 MiB, whether declared by Content-Length or streamed in chunks', () =>
    withService(async (service) => {
      const padding = 'x'.repeat(ONE_MIB);
      const oversized = JSON.stringify({ events: [usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 1)], padding });
      const declared = await service.send('POST', '/events', oversized);
      assert.equal(declared.status, 413);
      assert.equal(typeof declared.json.error, 'string');

      const chunked = await service.send('POST', '/events', [oversized.slice(0, 600_000), oversized.slice(600_000)]);
      assert.equal(chunked.status, 413);
      assert.deepEqual(tableCounts(service), [0, 0, 0, 0, 0]);
    }));

  test('a body of exactly 1 MiB is still accepted', () =>
    withService(async (service) => {
      const event = usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 1);
      const empty = JSON.stringify({ events: [event], padding: '' });
      const body = JSON.stringify({ events: [event], padding: 'x'.repeat(ONE_MIB - Buffer.byteLength(empty)) });
      assert.equal(Buffer.byteLength(body), ONE_MIB);
      assert.equal((await service.send('POST', '/events', body)).status, 201);
    }));
});

describe('what ingest derives', () => {
  test('session: started_ts is the min and last_ts the max ts, whatever the arrival order', () =>
    withService(async (service) => {
      await service.post([usage('s', 'main', 'm', DAY1 + 5000, [1, 1, 1, 1], 1)]);
      await service.post([tool('s', 'main', 'Bash', DAY1 + 9000), tool('s', 'main', 'Bash', DAY1 + 2000)]);
      const row = service.db.prepare('SELECT started_ts, last_ts FROM session WHERE id = ?').get('s') as { started_ts: number; last_ts: number };
      assert.equal(row.started_ts, DAY1 + 2000);
      assert.equal(row.last_ts, DAY1 + 9000);
    }));

  test('session: cwd comes from a session event, a later one replaces it, other events keep it', () =>
    withService(async (service) => {
      const cwd = () => (service.db.prepare('SELECT cwd FROM session WHERE id = ?').get('s') as { cwd: string | null }).cwd;
      await service.post([usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 1)]);
      assert.equal(cwd(), null);
      await service.post([sessionEvent('s', DAY1 + 1, 'start', '/first')]);
      assert.equal(cwd(), '/first');
      await service.post([sessionEvent('s', DAY1 + 2, 'clear')]);
      assert.equal(cwd(), '/first');
      await service.post([sessionEvent('s', DAY1 + 3, 'start', '/second'), tool('s', 'main', 'Bash', DAY1 + 4)]);
      assert.equal(cwd(), '/second');
    }));

  test('agent: an agent event sets label and model, an empty label does not erase the label', () =>
    withService(async (service) => {
      await service.post([agentEvent('s', 'sub-1', DAY1, 'explore', 'm-1')]);
      await service.post([agentEvent('s', 'sub-1', DAY1 + 1, '')]);
      const [agent] = (await service.get('/api/sessions/s')).json.agents;
      assert.equal(agent.label, 'explore');
      assert.equal(agent.model, 'm-1');
    }));

  test('agent: a usage event sets the model only when it is empty, an agent event can replace it', () =>
    withService(async (service) => {
      const model = async () => (await service.get('/api/sessions/s')).json.agents[0].model;
      await service.post([usage('s', 'main', 'first', DAY1, [1, 1, 1, 1], 1)]);
      assert.equal(await model(), 'first');
      await service.post([usage('s', 'main', 'second', DAY1 + 1, [1, 1, 1, 1], 1)]);
      assert.equal(await model(), 'first');
      await service.post([agentEvent('s', 'main', DAY1 + 2, '', 'third')]);
      assert.equal(await model(), 'third');
    }));

  test('an agent that only ever made tool calls still gets a row in the session detail', () =>
    withService(async (service) => {
      await service.post([tool('s', 'ghost', 'Bash', DAY1)]);
      const { agents } = (await service.get('/api/sessions/s')).json;
      assert.deepEqual(agents, [
        { agent: 'ghost', label: '', model: '', requests: 0, tools: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
      ]);
    }));
});

// ---- Read routes ------------------------------------------------------------------------------------

describe('read routes', () => {
  test('GET /health answers 200 ok', () =>
    withService(async (service) => {
      const reply = await service.get('/health');
      assert.equal(reply.status, 200);
      assert.equal(reply.text, 'ok');
      assert.equal(reply.headers['cache-control'], 'no-store');
    }));

  test('GET /api/sessions is empty before any event', () =>
    withService(async (service) => {
      const reply = await service.get('/api/sessions');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json, []);
    }));

  test('GET /api/sessions lists the newest session first with hand-computed totals', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const reply = await service.get('/api/sessions');
      assert.equal(reply.status, 200);
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.deepEqual(reply.json, [
        // sess-b: one priced request
        { session: 'sess-b', startedTs: DAY2 + 5 * HOUR, lastTs: DAY2 + 5 * HOUR, cwd: null,
          requests: 1, tools: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.125, models: ['m-big'] },
        // sess-a: 3 requests (100+200+10 in, 50+20+5 out, 1000+2000+100 cache read, 10+0+1 cache write),
        // 5 tool calls, cost 0.25 + 0.5 with the null-priced request skipped; m-big (2 requests) before m-small (1)
        { session: 'sess-a', startedTs: DAY1 + 10 * HOUR, lastTs: DAY2 + HOUR, cwd: '/work/a',
          requests: 3, tools: 5, input: 310, output: 75, cacheRead: 3100, cacheWrite: 11, costUsd: 0.75, models: ['m-big', 'm-small'] },
      ]);
    }));

  test('GET /api/sessions honours limit and rejects values outside 1-500', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const limited = await service.get('/api/sessions?limit=1');
      assert.deepEqual(limited.json.map((row: Raw) => row.session), ['sess-b']);
      assert.equal((await service.get('/api/sessions?limit=500')).status, 200);
      for (const bad of ['0', '501', '-1', 'abc', '1.5', '']) {
        assert.equal((await service.get(`/api/sessions?limit=${bad}`)).status, 400, `limit=${bad}`);
      }
    }));

  test('GET /api/sessions orders by last activity, then later start, then id; not by start', () =>
    withService(async (service) => {
      const at = (hour: number) => DAY1 + hour * HOUR;
      await service.post([
        // started first, still busy at 20:00: must lead although it is the oldest
        sessionEvent('busy-old', at(10), 'start'), tool('busy-old', 'main', 'Bash', at(20)),
        // started last, quiet after 12:05: must come after everything that was active later
        sessionEvent('quiet-new', at(12), 'start'), tool('quiet-new', 'main', 'Bash', at(12) + 5 * 60_000),
        sessionEvent('middle', at(11), 'start'), tool('middle', 'main', 'Bash', at(15)),
        // same last activity as busy-old, started later: ahead of it
        sessionEvent('tie-later-start', at(19), 'start'), tool('tie-later-start', 'main', 'Bash', at(20)),
        // identical start and last activity: by id
        sessionEvent('tie-b', at(13), 'start'), sessionEvent('tie-a', at(13), 'start'),
      ]);
      const order = async (query = '') => (await service.get(`/api/sessions${query}`)).json.map((row: Raw) => row.session);
      assert.deepEqual(await order(), ['tie-later-start', 'busy-old', 'middle', 'tie-a', 'tie-b', 'quiet-new']);
      assert.deepEqual(await order('?limit=2'), ['tie-later-start', 'busy-old']);
      // the page is the most recently active sessions, so a long-running one does not fall off it
      assert.deepEqual(await order('?limit=3'), ['tie-later-start', 'busy-old', 'middle']);
    }));

  test('GET /api/sessions with a limit totals only the sessions on the page, the same as the full list', () =>
    withService(async (service) => {
      await service.post([
        ...fixtureEvents(),
        usage('sess-c', 'main', 'm-big', DAY2 + 8 * HOUR, [7, 7, 7, 7], 0.5),
        tool('sess-c', 'main', 'Bash', DAY2 + 8 * HOUR),
        tool('sess-c', 'main', 'Bash', DAY2 + 8 * HOUR),
      ]);
      const full = (await service.get('/api/sessions')).json;
      assert.deepEqual(full.map((row: Raw) => row.session), ['sess-c', 'sess-b', 'sess-a']);
      assert.equal(full[0].tools, 2);
      for (const limit of [1, 2]) {
        assert.deepEqual((await service.get(`/api/sessions?limit=${limit}`)).json, full.slice(0, limit), `limit=${limit}`);
      }
    }));

  test('the sessions list and the session detail read only the sessions they report on, never a whole table', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const lines = (sql: string, params: Record<string, string | number>) =>
        (service.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[]).map((row) => row.detail);
      for (const [name, plan] of [
        ['list', lines(SESSION_LIST_SQL, { limit: 2 })],
        ['detail', lines(SESSION_DETAIL_SQL, { session: 'sess-a' })],
      ] as const) {
        for (const table of ['usage_event', 'tool_call']) {
          const reads = plan.filter((line) => line.includes(table));
          assert.ok(reads.length > 0, `${name}: the plan reads ${table}`);
          for (const line of reads) assert.match(line, /^SEARCH /, `${name}: ${line}`);
        }
      }
    }));

  test('costUsd is null for a session that has no priced usage, and the sum of the priced ones otherwise', () =>
    withService(async (service) => {
      await service.post([
        usage('unpriced', 'main', 'm', DAY1, [1, 1, 1, 1], null),
        usage('unpriced', 'main', 'm', DAY1 + 1, [1, 1, 1, 1], null),
        sessionEvent('quiet', DAY1 + 2 * HOUR, 'start'),
        usage('free', 'main', 'm', DAY1 + 3 * HOUR, [1, 1, 1, 1], 0),
        usage('mixed', 'main', 'm', DAY1 + 4 * HOUR, [1, 1, 1, 1], null),
        usage('mixed', 'main', 'm', DAY1 + 4 * HOUR + 1, [1, 1, 1, 1], 0.5),
      ]);
      const bySession = Object.fromEntries((await service.get('/api/sessions')).json.map((row: Raw) => [row.session, row]));
      assert.equal(bySession.unpriced.costUsd, null);
      assert.equal(bySession.unpriced.requests, 2);
      // no usage events at all: zero totals, and no cost to speak of
      assert.deepEqual(bySession.quiet, { session: 'quiet', startedTs: DAY1 + 2 * HOUR, lastTs: DAY1 + 2 * HOUR, cwd: null,
        requests: 0, tools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, models: [] });
      assert.equal(bySession.free.costUsd, 0); // priced at zero is not unpriced
      assert.equal(bySession.mixed.costUsd, 0.5);
      assert.equal((await service.get('/api/sessions/unpriced')).json.costUsd, null);
      assert.equal((await service.get('/api/sessions/quiet')).json.costUsd, null);
      assert.equal((await service.get('/api/sessions/free')).json.costUsd, 0);
      assert.equal((await service.get('/api/sessions/mixed')).json.costUsd, 0.5);
    }));

  test('costUsd is null for an agent, a day and a model whose events are all unpriced', () =>
    withService(async (service) => {
      await service.post([
        usage('s', 'main', 'priced-model', DAY1, [1, 1, 1, 1], 0.25),
        usage('s', 'sub-1', 'free-model', DAY1 + 1, [1, 1, 1, 1], null),
        usage('s', 'sub-2', 'free-model', DAY2, [1, 1, 1, 1], null),
        tool('s', 'main', 'Bash', DAY2),
        tool('s', 'sub-3', 'Bash', DAY2 + 1), // an agent with tool calls and no usage
        tool('s', 'main', 'Bash', DAY2 + 24 * HOUR), // a day of tool calls only
      ]);
      const agents = (await service.get('/api/sessions/s')).json.agents;
      assert.deepEqual(agents.map((row: Raw) => [row.agent, row.costUsd]), [['main', 0.25], ['sub-1', null], ['sub-2', null], ['sub-3', null]]);
      const { byDay, byModel } = (await service.get('/api/summary')).json;
      // 01-01 mixes a priced and an unpriced request: their sum; 01-02 has an unpriced request and a tool call; 01-03 only a tool call
      assert.deepEqual(byDay.map((row: Raw) => [row.day, row.costUsd]), [['2026-01-01', 0.25], ['2026-01-02', null], ['2026-01-03', null]]);
      assert.deepEqual(byModel.map((row: Raw) => [row.model, row.costUsd]), [['priced-model', 0.25], ['free-model', null]]);
    }));

  test('GET /api/sessions/:id returns totals, per-agent rows (main first) and tool counts', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const reply = await service.get('/api/sessions/sess-a');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json, {
        session: 'sess-a', startedTs: DAY1 + 10 * HOUR, lastTs: DAY2 + HOUR, cwd: '/work/a',
        requests: 3, input: 310, output: 75, cacheRead: 3100, cacheWrite: 11, costUsd: 0.75,
        agents: [
          // main: 2 requests, 4 tool calls (Bash, Bash, Read, Edit); model set by its first usage event
          { agent: 'main', label: '', model: 'm-big', requests: 2, tools: 4,
            input: 300, output: 70, cacheRead: 3000, cacheWrite: 10, costUsd: 0.75 },
          // sub-1: labelled by an agent event; its only request has no list price, so its cost is null
          { agent: 'sub-1', label: 'explore', model: 'm-small', requests: 1, tools: 1,
            input: 10, output: 5, cacheRead: 100, cacheWrite: 1, costUsd: null },
        ],
        // `tools` is the per-tool list here (the contract's shape); 5 calls in all: Bash 2, Read 1 + 1, Edit 1, by count then name
        tools: [{ tool: 'Bash', count: 2 }, { tool: 'Read', count: 2 }, { tool: 'Edit', count: 1 }],
      });
    }));

  test('GET /api/sessions/:id is 404 for an unknown or malformed id', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      for (const path of ['/api/sessions/nope', '/api/sessions/%E0%A4%A', '/api/sessions/']) {
        const reply = await service.get(path);
        assert.equal(reply.status, 404, path);
        assert.equal(typeof reply.json.error, 'string');
      }
    }));

  test('GET /api/summary groups cost, tokens and calls by UTC day and by model', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const reply = await service.get('/api/summary');
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.json, {
        byDay: [
          // 01-01: requests at 11:00 and 12:00 (100+200 in, 50+20 out, 1000+2000 cr, 10+0 cw, 0.25+0.5), 4 tool calls
          { day: '2026-01-01', requests: 2, tools: 4, input: 300, output: 70, cacheRead: 3000, cacheWrite: 10, costUsd: 0.75 },
          // 01-02: sub-1 (unpriced) and sess-b requests, 2 tool calls
          { day: '2026-01-02', requests: 2, tools: 2, input: 11, output: 6, cacheRead: 100, cacheWrite: 1, costUsd: 0.125 },
        ],
        byModel: [
          // m-big: 3 requests, 0.25 + 0.5 + 0.125
          { model: 'm-big', requests: 3, input: 301, output: 71, cacheRead: 3000, cacheWrite: 10, costUsd: 0.875 },
          // m-small: its only request is unpriced, so the cost is null and the model sorts after the priced one
          { model: 'm-small', requests: 1, input: 10, output: 5, cacheRead: 100, cacheWrite: 1, costUsd: null },
        ],
      });
    }));

  test('GET /api/summary buckets days in the tz offset, in minutes east of UTC', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      // UTC-12: 01-01 11:00 falls on 12-31; 12:00 and the 01-02 requests fall on 01-01
      const west = (await service.get('/api/summary?tz=-720')).json;
      assert.deepEqual(west.byDay.map((row: Raw) => [row.day, row.requests]).slice(0, 2), [['2025-12-31', 1], ['2026-01-01', 3]]);
      for (const bad of ['1.5', 'x', '841', '-841']) {
        const reply = await service.get(`/api/summary?tz=${bad}`);
        assert.equal(reply.status, 400, bad);
      }
    }));

  test('GET /api/tools counts calls per tool and lists each call newest first, with its session and agent', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const reply = await service.get('/api/tools');
      assert.equal(reply.status, 200);
      // Bash 2, Read 2, Edit 2 (sess-a Edit + sess-b Edit): ties by name
      assert.deepEqual(reply.json.byTool, [
        { tool: 'Bash', count: 2 }, { tool: 'Edit', count: 2 }, { tool: 'Read', count: 2 },
      ]);
      assert.equal(reply.json.calls.length, 6);
      assert.deepEqual(reply.json.calls[0], {
        ts: DAY2 + 5 * HOUR, tool: 'Edit', session: 'sess-b', agent: 'main', label: '', cwd: null, detail: null,
      });
      assert.deepEqual(reply.json.calls[1], {
        ts: DAY2 + HOUR, tool: 'Read', session: 'sess-a', agent: 'sub-1', label: 'explore', cwd: '/work/a', detail: null,
      });
    }));

  test('GET /api/tools returns the detail a tool event was sent with', () =>
    withService(async (service) => {
      await service.post([tool('s', 'main', 'Bash', DAY1, 'npm test')]);
      assert.equal((await service.get('/api/tools')).json.calls[0].detail, 'npm test');
    }));

  test('GET /api/tools?session= keeps one session\'s calls and counts', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const b = (await service.get('/api/tools?session=sess-b')).json;
      assert.deepEqual(b.byTool, [{ tool: 'Edit', count: 1 }]);
      assert.deepEqual(b.calls.map((c: Raw) => c.session), ['sess-b']);
      assert.deepEqual((await service.get('/api/tools?session=nope')).json, { byTool: [], calls: [] });
    }));

  test('GET /api/tools bounds by from/to and caps the call list with limit', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const day2 = (await service.get(`/api/tools?from=${DAY2}`)).json;
      assert.deepEqual(day2.byTool, [{ tool: 'Edit', count: 1 }, { tool: 'Read', count: 1 }]);
      const capped = (await service.get('/api/tools?limit=2')).json;
      assert.equal(capped.calls.length, 2);
      assert.equal(capped.byTool.length, 3); // the counts are not capped
      assert.equal((await service.get('/api/tools?limit=0')).status, 400);
    }));

  test('GET /api/settings reports the daily budget, or null when none is set', async () => {
    await withService(async (service) => {
      assert.deepEqual((await service.get('/api/settings')).json, { dailyBudgetUsd: 20 });
    }, { dailyBudgetUsd: 20 });
    await withService(async (service) => {
      assert.deepEqual((await service.get('/api/settings')).json, { dailyBudgetUsd: null });
    }, { dailyBudgetUsd: null });
  });

  test('GET /api/summary on an empty database has empty lists', () =>
    withService(async (service) => {
      assert.deepEqual((await service.get('/api/summary')).json, { byDay: [], byModel: [] });
    }));

  test('GET /api/summary from/to bound both lists and include the edges', () =>
    withService(async (service) => {
      await service.post(fixtureEvents());
      const onlyDay2 = (await service.get(`/api/summary?from=${DAY2}`)).json;
      assert.deepEqual(onlyDay2.byDay.map((row: Raw) => row.day), ['2026-01-02']);
      assert.deepEqual(onlyDay2.byModel.map((row: Raw) => [row.model, row.requests]), [['m-big', 1], ['m-small', 1]]);

      const onlyDay1 = (await service.get(`/api/summary?to=${DAY2 - 1}`)).json;
      assert.deepEqual(onlyDay1.byDay.map((row: Raw) => row.day), ['2026-01-01']);

      // exactly 12:00 on day 1: one request (0.5) and three tool calls
      const edge = (await service.get(`/api/summary?from=${DAY1 + 12 * HOUR}&to=${DAY1 + 12 * HOUR}`)).json;
      assert.deepEqual(edge.byDay, [
        { day: '2026-01-01', requests: 1, tools: 3, input: 200, output: 20, cacheRead: 2000, cacheWrite: 0, costUsd: 0.5 },
      ]);
      assert.deepEqual(edge.byModel, [
        { model: 'm-big', requests: 1, input: 200, output: 20, cacheRead: 2000, cacheWrite: 0, costUsd: 0.5 },
      ]);

      assert.deepEqual((await service.get(`/api/summary?from=${DAY2 + 24 * HOUR}`)).json, { byDay: [], byModel: [] });
    }));

  test('GET /api/summary splits days at UTC midnight', () =>
    withService(async (service) => {
      await service.post([
        usage('s', 'main', 'm', DAY2 - 1, [1, 0, 0, 0], 1),
        usage('s', 'main', 'm', DAY2, [2, 0, 0, 0], 2),
      ]);
      const { byDay } = (await service.get('/api/summary')).json;
      assert.deepEqual(byDay.map((row: Raw) => [row.day, row.input, row.costUsd]), [['2026-01-01', 1, 1], ['2026-01-02', 2, 2]]);
    }));

  test('GET /api/summary rejects a from/to that is not an integer', () =>
    withService(async (service) => {
      for (const query of ['from=abc', 'to=1.5', 'from=-1', 'to=', 'from=1e3']) {
        assert.equal((await service.get(`/api/summary?${query}`)).status, 400, query);
      }
    }));

  test('null costUsd is skipped in every sum, and priced requests still add up', () =>
    withService(async (service) => {
      await service.post([
        usage('s', 'main', 'm', DAY1, [1, 1, 1, 1], 0.25),
        usage('s', 'main', 'm', DAY1 + 1, [1, 1, 1, 1], null),
        usage('s', 'main', 'm', DAY1 + 2, [1, 1, 1, 1], 0.5),
      ]);
      assert.equal((await service.get('/api/sessions')).json[0].costUsd, 0.75);
      assert.equal((await service.get('/api/sessions/s')).json.costUsd, 0.75);
      assert.equal((await service.get('/api/sessions/s')).json.agents[0].costUsd, 0.75);
      const summary = (await service.get('/api/summary')).json;
      assert.equal(summary.byDay[0].costUsd, 0.75);
      assert.equal(summary.byDay[0].requests, 3);
      assert.equal(summary.byModel[0].costUsd, 0.75);
      assert.equal(summary.byModel[0].requests, 3);
    }));
});

// ---- Response headers -------------------------------------------------------------------------------

const HARDENING_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "frame-ancestors 'none'",
};

describe('response headers', () => {
  test('every reply says nosniff, same-origin CORP and frame-ancestors none, whatever its status or type', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      const events = fixtureEvents();
      const replies: [string, Reply][] = [
        ['201 ingest', await service.post(events)],
        ['201 duplicate batch', await service.post(events)],
        ['400 invalid event', await service.post([{ ...events[1], costUsd: -1 }])],
        ['400 bad JSON', await service.send('POST', '/events', '{')],
        ['413 too large', await service.send('POST', '/events', 'x'.repeat(ONE_MIB + 1))],
        ['200 health (text)', await service.get('/health')],
        ['200 sessions', await service.get('/api/sessions')],
        ['200 detail', await service.get('/api/sessions/sess-a')],
        ['404 unknown session', await service.get('/api/sessions/nope')],
        ['200 summary', await service.get('/api/summary')],
        ['400 bad query', await service.get('/api/summary?from=abc')],
        ['404 unknown route', await service.get('/nope')],
        ['405 wrong method', await service.send('DELETE', '/events')],
        ['200 index', await service.get('/')],
        ['200 immutable asset', await service.get('/assets/index-AbC123.js')],
        ['200 plain file', await service.get('/favicon.ico')],
        ['404 missing file', await service.get('/assets/missing.js')],
      ];
      for (const [name, reply] of replies) {
        for (const [header, value] of Object.entries(HARDENING_HEADERS)) {
          assert.equal(reply.headers[header], value, `${name}: ${header}`);
        }
      }
    }));

  test('the dashboard placeholder carries them too', () =>
    withService(async (service) => {
      const reply = await service.get('/');
      assert.match(reply.text, /Dashboard not built yet/);
      for (const [header, value] of Object.entries(HARDENING_HEADERS)) assert.equal(reply.headers[header], value, header);
    }));
});

// ---- Routing ----------------------------------------------------------------------------------------

describe('routing', () => {
  test('an unknown route is 404 with a JSON error', () =>
    withService(async (service) => {
      for (const path of ['/nope', '/api', '/api/nope', '/api/summary/extra', '/events/1', '/healthz']) {
        const reply = await service.get(path);
        assert.equal(reply.status, 404, path);
        assert.equal(typeof reply.json.error, 'string');
        assert.equal(reply.headers['cache-control'], 'no-store');
      }
      assert.equal((await service.send('POST', '/nope', '{}')).status, 404);
    }));

  test('a known route with the wrong method is 405 and names the allowed method', () =>
    withService(async (service) => {
      const cases: [string, string, string][] = [
        ['GET', '/events', 'POST'],
        ['PUT', '/events', 'POST'],
        ['POST', '/health', 'GET'],
        ['POST', '/api/sessions', 'GET'],
        ['DELETE', '/api/sessions/x', 'GET'],
        ['POST', '/api/summary', 'GET'],
        ['POST', '/', 'GET'],
      ];
      for (const [method, path, allow] of cases) {
        const reply = await service.send(method, path);
        assert.equal(reply.status, 405, `${method} ${path}`);
        assert.equal(reply.headers.allow, allow);
        assert.equal(typeof reply.json.error, 'string');
      }
    }));
});

// ---- Static files: the built dashboard in web/dist --------------------------------------------------

function writeFixtureDist(distDir: string): void {
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  const files: Record<string, string> = {
    'index.html': '<!doctype html><title>fixture dashboard</title><div id="root"></div>',
    'assets/index-AbC123.js': 'console.log("app")',
    'assets/index-AbC123.css': 'body{margin:0}',
    'assets/index-AbC123.js.map': '{"version":3}',
    'assets/inter-latin-400.woff2': 'woff2-bytes',
    'assets/logo.png': 'png-bytes',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'favicon.ico': 'ico-bytes',
    'manifest.json': '{"name":"x"}',
    'notes.txt': 'not a served type',
    '.hidden.js': 'dotfile',
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(distDir, name), content);
}

describe('static files', () => {
  test('GET / serves dist/index.html as no-store HTML', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      const reply = await service.get('/');
      assert.equal(reply.status, 200);
      assert.match(reply.text, /fixture dashboard/);
      assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(reply.headers['cache-control'], 'no-store');
    }));

  test('files are served with their content type; only /assets/ is cached as immutable', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      const cases: [string, string, string][] = [
        ['/index.html', 'text/html; charset=utf-8', 'no-store'],
        ['/assets/index-AbC123.js', 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
        ['/assets/index-AbC123.css', 'text/css; charset=utf-8', 'public, max-age=31536000, immutable'],
        ['/assets/index-AbC123.js.map', 'application/json; charset=utf-8', 'public, max-age=31536000, immutable'],
        ['/assets/inter-latin-400.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
        ['/assets/logo.png', 'image/png', 'public, max-age=31536000, immutable'],
        ['/favicon.svg', 'image/svg+xml', 'no-store'],
        ['/favicon.ico', 'image/x-icon', 'no-store'],
        ['/manifest.json', 'application/json; charset=utf-8', 'no-store'],
      ];
      for (const [path, contentType, cacheControl] of cases) {
        const reply = await service.get(path);
        assert.equal(reply.status, 200, path);
        assert.equal(reply.headers['content-type'], contentType, path);
        assert.equal(reply.headers['cache-control'], cacheControl, path);
      }
      assert.equal((await service.get('/assets/index-AbC123.js')).text, 'console.log("app")');
    }));

  test('there is no single-page-app fallback: unknown paths, directories and other file types are 404', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      for (const path of ['/session/abc', '/assets', '/assets/', '/assets/missing.js', '/notes.txt', '/.hidden.js', '/index']) {
        assert.equal((await service.get(path)).status, 404, path);
      }
    }));

  test('a static file only answers GET: 405 for other methods, 404 for a file that does not exist', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      const present = await service.send('POST', '/assets/index-AbC123.js', '{}');
      assert.equal(present.status, 405);
      assert.equal(present.headers.allow, 'GET');
      assert.equal((await service.send('POST', '/assets/missing.js', '{}')).status, 404);
    }));

  test('path traversal is refused', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      // Outside dist/, right next to it: the only file a traversal could reach.
      fs.writeFileSync(path.join(service.scratch, 'secret.json'), '{"secret":true}');
      const attempts = [
        '/../secret.json',
        '/assets/../../secret.json',
        '/%2e%2e/secret.json',
        '/%2E%2E/secret.json',
        '/assets/%2e%2e/%2e%2e/secret.json',
        '/..%2fsecret.json',
        '/%2e%2e%2fsecret.json',
        '/assets/..%2f..%2fsecret.json',
        '/..%5csecret.json',
        '/assets\\..\\..\\secret.json',
        '/%252e%252e/secret.json',
        '//secret.json',
        '/index.html%00.png',
        '/etc/passwd',
        '/../../../../etc/passwd',
        '/assets/../../../../../../etc/passwd',
      ];
      for (const attempt of attempts) {
        const reply = await service.get(attempt);
        assert.notEqual(reply.status, 200, attempt);
        assert.doesNotMatch(reply.text, /"secret"|root:/, attempt);
      }
    }));
});

describe('dashboard not built', () => {
  test('GET / answers 200 with an inline placeholder when dist/index.html is missing', () =>
    withService(async (service) => {
      const reply = await service.get('/');
      assert.equal(reply.status, 200);
      assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(reply.headers['cache-control'], 'no-store');
      assert.match(reply.text, /Dashboard not built yet: run <code>npm install && npm run build<\/code> in web\//);
    }));

  test('the placeholder covers a dist directory that holds other files but no index.html', () =>
    withService(async (service) => {
      writeFixtureDist(service.distDir);
      fs.rmSync(path.join(service.distDir, 'index.html'));
      assert.match((await service.get('/')).text, /Dashboard not built yet/);
      assert.equal((await service.get('/index.html')).status, 404);
    }));

  test('only GET / gets the placeholder; other paths stay 404', () =>
    withService(async (service) => {
      assert.equal((await service.get('/index.html')).status, 404);
      assert.equal((await service.get('/assets/index.js')).status, 404);
      assert.equal((await service.get('/anything')).status, 404);
    }));
});
