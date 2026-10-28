import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { distDir as defaultDistDir } from './config.ts';
import { inTransaction } from './db.ts';
import { parseBatch, ValidationError, type MonitorEvent } from './events.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;
const DEFAULT_TOOL_LIMIT = 200;
const MAX_TOOL_LIMIT = 1000;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

// On every response, both listeners: no content sniffing, no cross-origin embedding of the data or the app, no framing.
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
};

const PLACEHOLDER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>usage-monitor</title>
<p>Dashboard not built yet: run <code>npm install && npm run build</code> in web/</p>
`;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Every segment starts with a letter, digit or underscore: no "..", no dotfiles, no "%" escapes.
const STATIC_PATH = /^(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

const INGEST_PATH = /^\/events$/;

// readOnly is the TCP listener's handler: GET and HEAD for the read routes and the dashboard, 404 for everything else, ingest included.
export type HandlerOptions = { distDir?: string; readOnly?: boolean };

type Context = { req: IncomingMessage; res: ServerResponse; url: URL; params: string[] };
type RouteHandler = (context: Context) => void | Promise<void>;
type Route = { pattern: RegExp; handlers: Record<string, RouteHandler> };

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createHandler(db: DatabaseSync, options: HandlerOptions = {}) {
  const distDir = options.distDir ?? defaultDistDir;
  const readOnly = options.readOnly ?? false;
  const ingestBatch = createIngest(db);
  const reads = createReads(db);

  const allRoutes: Route[] = [
    { pattern: /^\/health$/, handlers: { GET: ({ res }) => send(res, 200, 'text/plain; charset=utf-8', 'ok') } },
    {
      pattern: INGEST_PATH,
      handlers: {
        POST: async ({ req, res }) => {
          const events = parseBatch(parseJson(await readBody(req)));
          sendJson(res, 201, ingestBatch(events));
        },
      },
    },
    {
      pattern: /^\/api\/sessions$/,
      handlers: { GET: ({ res, url }) => sendJson(res, 200, reads.sessions(sessionLimit(url))) },
    },
    {
      pattern: /^\/api\/sessions\/([^/]+)$/,
      handlers: {
        GET: ({ res, params }) => {
          const detail = reads.sessionDetail(decodeSegment(params[0]));
          if (!detail) throw new HttpError(404, 'unknown session');
          sendJson(res, 200, detail);
        },
      },
    },
    {
      pattern: /^\/api\/summary$/,
      handlers: {
        GET: ({ res, url }) =>
          sendJson(res, 200, reads.summary(timeParam(url, 'from', Number.MIN_SAFE_INTEGER), timeParam(url, 'to', Number.MAX_SAFE_INTEGER))),
      },
    },
    {
      pattern: /^\/api\/tools$/,
      handlers: {
        GET: ({ res, url }) =>
          sendJson(
            res,
            200,
            reads.tools(timeParam(url, 'from', Number.MIN_SAFE_INTEGER), timeParam(url, 'to', Number.MAX_SAFE_INTEGER), toolLimit(url)),
          ),
      },
    },
    { pattern: /^\/$/, handlers: { GET: ({ res }) => serveIndex(res, distDir) } },
  ];
  const routes = readOnly ? allRoutes.filter((route) => route.pattern !== INGEST_PATH) : allRoutes;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await dispatch(req, res);
    } catch (error) {
      respondToError(res, error);
    }
  };

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = parseRequestUrl(req.url);
    // Read-only, HEAD is a GET whose body node drops.
    const method = readOnly && req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    if (readOnly && method !== 'GET') throw new HttpError(404, 'not found');

    for (const route of routes) {
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      if (!Object.hasOwn(route.handlers, method)) return methodNotAllowed(res, Object.keys(route.handlers));
      return route.handlers[method]({ req, res, url, params: match.slice(1) });
    }

    const file = await findStaticFile(distDir, url.pathname);
    if (!file) throw new HttpError(404, 'not found');
    if (method !== 'GET') return methodNotAllowed(res, ['GET']);
    await serveFile(res, file, url.pathname);
  }
}

// ---- Ingest -----------------------------------------------------------------------------------

function createIngest(db: DatabaseSync) {
  const insertUsage = db.prepare(`
    INSERT OR IGNORE INTO usage_event (event_id, session, agent, ts, model, input, output, cache_read, cache_write, cost_usd)
    VALUES (:id, :session, :agent, :ts, :model, :input, :output, :cacheRead, :cacheWrite, :costUsd)`);
  const insertTool = db.prepare(`
    INSERT OR IGNORE INTO tool_call (event_id, session, agent, ts, tool, detail)
    VALUES (:id, :session, :agent, :ts, :tool, :detail)`);
  const insertStateEvent = db.prepare('INSERT OR IGNORE INTO state_event (event_id) VALUES (:id)');
  const upsertSession = db.prepare(`
    INSERT INTO session (id, started_ts, last_ts, cwd) VALUES (:session, :ts, :ts, :cwd)
    ON CONFLICT (id) DO UPDATE SET
      started_ts = min(started_ts, excluded.started_ts),
      last_ts = max(last_ts, excluded.last_ts),
      cwd = coalesce(excluded.cwd, cwd)`);
  const upsertAgentFromEvent = db.prepare(`
    INSERT INTO agent (session, agent, label, model) VALUES (:session, :agent, :label, :model)
    ON CONFLICT (session, agent) DO UPDATE SET
      label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE label END,
      model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE model END`);
  const upsertAgentFromUsage = db.prepare(`
    INSERT INTO agent (session, agent, model) VALUES (:session, :agent, :model)
    ON CONFLICT (session, agent) DO UPDATE SET model = CASE WHEN model = '' THEN excluded.model ELSE model END`);

  // True when the event was new; a duplicate changes nothing.
  function store(event: MonitorEvent): boolean {
    switch (event.type) {
      case 'usage': {
        const { type, ...columns } = event; // what is left are exactly the statement's named parameters
        if (insertUsage.run(columns).changes === 0) return false;
        upsertAgentFromUsage.run({ session: event.session, agent: event.agent, model: event.model });
        return true;
      }
      case 'tool': {
        const { type, ...columns } = event;
        return insertTool.run({ ...columns, detail: event.detail ?? null }).changes > 0;
      }
      case 'agent':
        if (insertStateEvent.run({ id: event.id }).changes === 0) return false;
        upsertAgentFromEvent.run({ session: event.session, agent: event.agent, label: event.label, model: event.model ?? '' });
        return true;
      case 'session':
        return insertStateEvent.run({ id: event.id }).changes > 0;
    }
  }

  return function ingestBatch(events: MonitorEvent[]): { accepted: number; duplicates: number } {
    let duplicates = 0;
    inTransaction(db, () => {
      for (const event of events) {
        if (!store(event)) {
          duplicates += 1;
          continue;
        }
        upsertSession.run({
          session: event.session,
          ts: event.ts,
          cwd: event.type === 'session' ? (event.cwd ?? null) : null,
        });
      }
    });
    return { accepted: events.length - duplicates, duplicates };
  };
}

// ---- Reads ------------------------------------------------------------------------------------

const USAGE_SUMS = `
  count(*) AS requests,
  sum(input) AS input,
  sum(output) AS output,
  sum(cache_read) AS cacheRead,
  sum(cache_write) AS cacheWrite,
  sum(cost_usd) AS costUsd`;

// Totals columns of a LEFT JOINed usage subquery `u` and tool subquery `t`; no rows means zeros, and no priced usage means a null cost.
const JOINED_TOTALS = `
  coalesce(u.requests, 0) AS requests,
  coalesce(t.tools, 0) AS tools,
  coalesce(u.input, 0) AS input,
  coalesce(u.output, 0) AS output,
  coalesce(u.cacheRead, 0) AS cacheRead,
  coalesce(u.cacheWrite, 0) AS cacheWrite,
  u.costUsd AS costUsd`;

// The sessions to report on come first (`page`), then usage and tool calls are totalled for those sessions only:
// SQLite does not push a join condition into a GROUP BY subquery, so the filter has to be inside it.
const sessionsSql = (pageQuery: string, scope: string, extra = '') => `
  WITH page AS MATERIALIZED (${pageQuery})
  SELECT s.id AS session, s.started_ts AS startedTs, s.last_ts AS lastTs, s.cwd AS cwd, ${JOINED_TOTALS}${extra}
  FROM page s
  LEFT JOIN (SELECT session, ${USAGE_SUMS} FROM usage_event WHERE ${scope} GROUP BY session) u ON u.session = s.id
  LEFT JOIN (SELECT session, count(*) AS tools FROM tool_call WHERE ${scope} GROUP BY session) t ON t.session = s.id
  ORDER BY s.last_ts DESC, s.started_ts DESC, s.id`;

// Last activity first, then the later start, then the id.
export const SESSION_LIST_SQL = sessionsSql(
  'SELECT id, started_ts, last_ts, cwd FROM session ORDER BY last_ts DESC, started_ts DESC, id LIMIT :limit',
  'session IN (SELECT id FROM page)',
  // The models a session's requests used, as a JSON array, most requests first.
  `, (SELECT json_group_array(model) FROM (
      SELECT model FROM usage_event WHERE session = s.id GROUP BY model ORDER BY count(*) DESC, model
    )) AS models`,
);
export const SESSION_DETAIL_SQL = sessionsSql(
  'SELECT id, started_ts, last_ts, cwd FROM session WHERE id = :session',
  'session = :session',
);

function createReads(db: DatabaseSync) {
  const listSessions = db.prepare(SESSION_LIST_SQL);
  const getSession = db.prepare(SESSION_DETAIL_SQL);

  // An agent can show up in usage or tool events without ever having an `agent` event, so the keys are a union.
  const listAgents = db.prepare(`
    SELECT k.agent AS agent, coalesce(a.label, '') AS label, coalesce(a.model, '') AS model, ${JOINED_TOTALS}
    FROM (
      SELECT agent FROM agent WHERE session = :session
      UNION SELECT agent FROM usage_event WHERE session = :session
      UNION SELECT agent FROM tool_call WHERE session = :session
    ) k
    LEFT JOIN agent a ON a.session = :session AND a.agent = k.agent
    LEFT JOIN (SELECT agent, ${USAGE_SUMS} FROM usage_event WHERE session = :session GROUP BY agent) u ON u.agent = k.agent
    LEFT JOIN (SELECT agent, count(*) AS tools FROM tool_call WHERE session = :session GROUP BY agent) t ON t.agent = k.agent
    ORDER BY k.agent <> 'main', k.agent`);

  const listTools = db.prepare(`
    SELECT tool, count(*) AS count FROM tool_call WHERE session = :session
    GROUP BY tool ORDER BY count DESC, tool`);

  const byDay = db.prepare(`
    SELECT day, sum(requests) AS requests, sum(tools) AS tools, sum(input) AS input, sum(output) AS output,
           sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite, sum(cost_usd) AS costUsd
    FROM (
      SELECT date(ts / 1000, 'unixepoch') AS day, 1 AS requests, 0 AS tools, input, output, cache_read, cache_write, cost_usd
      FROM usage_event WHERE ts BETWEEN :from AND :to
      UNION ALL
      SELECT date(ts / 1000, 'unixepoch'), 0, 1, 0, 0, 0, 0, NULL
      FROM tool_call WHERE ts BETWEEN :from AND :to
    )
    GROUP BY day ORDER BY day`);

  const byModel = db.prepare(`
    SELECT model, count(*) AS requests, sum(input) AS input, sum(output) AS output,
           sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite, sum(cost_usd) AS costUsd
    FROM usage_event WHERE ts BETWEEN :from AND :to
    GROUP BY model ORDER BY costUsd DESC, sum(input + output + cache_read + cache_write) DESC, model`);

  const toolCounts = db.prepare(`
    SELECT tool, count(*) AS count FROM tool_call WHERE ts BETWEEN :from AND :to
    GROUP BY tool ORDER BY count DESC, tool`);

  // Each call with its session's directory, its agent's label, and the mod's summary of its input (null when none was sent).
  const toolCalls = db.prepare(`
    SELECT c.ts AS ts, c.tool AS tool, c.session AS session, c.agent AS agent, coalesce(a.label, '') AS label, s.cwd AS cwd,
           c.detail AS detail
    FROM tool_call c
    LEFT JOIN agent a ON a.session = c.session AND a.agent = c.agent
    LEFT JOIN session s ON s.id = c.session
    WHERE c.ts BETWEEN :from AND :to
    ORDER BY c.ts DESC, c.rowid DESC
    LIMIT :limit`);

  return {
    tools: (from: number, to: number, limit: number) => ({
      byTool: toolCounts.all({ from, to }),
      calls: toolCalls.all({ from, to, limit }),
    }),
    sessions: (limit: number) =>
      listSessions.all({ limit }).map((row) => ({ ...row, models: JSON.parse(row.models as string) as string[] })),
    sessionDetail(session: string) {
      const row = getSession.get({ session });
      if (!row) return null;
      // The contract gives the detail's `tools` key to the per-tool counts, so the numeric total is left out.
      const { tools: _toolTotal, ...totals } = row;
      return { ...totals, agents: listAgents.all({ session }), tools: listTools.all({ session }) };
    },
    summary: (from: number, to: number) => ({ byDay: byDay.all({ from, to }), byModel: byModel.all({ from, to }) }),
  };
}

function sessionLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_SESSION_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_SESSION_LIMIT)) {
    throw new HttpError(400, `limit must be an integer from 1 to ${MAX_SESSION_LIMIT}`);
  }
  return limit;
}

function toolLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_TOOL_LIMIT;
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_TOOL_LIMIT)) {
    throw new HttpError(400, `limit must be an integer from 1 to ${MAX_TOOL_LIMIT}`);
  }
  return limit;
}

function timeParam(url: URL, name: 'from' | 'to', fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `${name} must be an integer, in ms since epoch`);
  return Number(raw);
}

// Only an origin-form target (starting with a single "/") is accepted, so "//host/x" cannot swap the host.
function parseRequestUrl(target = '/'): URL {
  if (!target.startsWith('/')) throw new HttpError(400, 'bad request target');
  return new URL(`http://usage-monitor${target}`);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(404, 'unknown session');
  }
}

// ---- Static files (the built dashboard) -------------------------------------------------------

async function serveIndex(res: ServerResponse, distDir: string): Promise<void> {
  const index = await findStaticFile(distDir, '/index.html');
  if (index) return serveFile(res, index, '/index.html');
  send(res, 200, CONTENT_TYPES['.html'], PLACEHOLDER_HTML);
}

// Maps a request path to a file inside distDir, or null. The path pattern and the extension
// list decide what is reachable, so nothing outside the built app can be named.
async function findStaticFile(distDir: string, pathname: string): Promise<string | null> {
  if (!STATIC_PATH.test(pathname) || !Object.hasOwn(CONTENT_TYPES, path.extname(pathname))) return null;
  const file = path.join(distDir, ...pathname.split('/'));
  try {
    return (await fs.stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

async function serveFile(res: ServerResponse, file: string, pathname: string): Promise<void> {
  const body = await fs.readFile(file);
  const cacheControl = pathname.startsWith('/assets/') ? IMMUTABLE_CACHE : NO_STORE;
  send(res, 200, CONTENT_TYPES[path.extname(file)], body, cacheControl);
}

// ---- HTTP plumbing ----------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit the rest of the upload is read and dropped, so the 413 reaches the client.
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new HttpError(413, 'body exceeds 1 MiB'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
  cacheControl = NO_STORE,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': cacheControl, ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload), NO_STORE, headers);
}

function methodNotAllowed(res: ServerResponse, allowed: string[]): void {
  sendJson(res, 405, { error: 'method not allowed' }, { Allow: allowed.join(', ') });
}

function respondToError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
  if (error instanceof ValidationError) return sendJson(res, 400, { error: error.message });
  console.error(error);
  sendJson(res, 500, { error: 'internal error' });
}
