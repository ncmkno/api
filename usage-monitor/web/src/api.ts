// Types mirror the README's "Read API" section. `cwd` is null for a session the API only knows from
// its events, and `costUsd` is null for a group none of whose events had a list price.

export interface Totals {
  requests: number;
  tools: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the events' costUsd (events without a list price are skipped); null when none of them had a price. */
  costUsd: number | null;
}

export interface Session extends Totals {
  session: string;
  startedTs: number;
  lastTs: number;
  cwd: string | null;
  /** The models the session's requests used, most requests first; empty when it made none. */
  models: string[];
}

export interface AgentUsage extends Totals {
  /** "main" for the main thread, else the subagent id. */
  agent: string;
  /** '' when unknown. */
  label: string;
  /** '' when unknown. */
  model: string;
}

export interface ToolCount {
  tool: string;
  count: number;
}

// On the detail route `tools` is the list [{ tool, count }] and there is no numeric `tools`;
// the session's total tool calls is the sum of the counts.
export interface SessionDetail extends Omit<Session, 'tools' | 'models'> {
  agents: AgentUsage[];
  tools: ToolCount[];
}

export interface DayUsage extends Totals {
  /** UTC YYYY-MM-DD. */
  day: string;
}

export interface ModelUsage extends Omit<Totals, 'tools'> {
  model: string;
}

export interface Summary {
  byDay: DayUsage[];
  byModel: ModelUsage[];
}

export interface ToolCall {
  ts: number;
  tool: string;
  session: string;
  /** "main" for the main thread, else the subagent id. */
  agent: string;
  /** '' when unknown. */
  label: string;
  cwd: string | null;
}

export interface Tools {
  byTool: ToolCount[];
  calls: ToolCall[];
}

export class ApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const TIMEOUT_MS = 8000;

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError('Network error or timeout');
  }
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return (await res.json()) as T;
}

export function fetchSessions(limit = 50, signal?: AbortSignal): Promise<Session[]> {
  return get(`/api/sessions?limit=${limit}`, signal);
}

export function fetchSession(id: string, signal?: AbortSignal): Promise<SessionDetail> {
  return get(`/api/sessions/${encodeURIComponent(id)}`, signal);
}

export function fetchSummary(range: { from?: number; to?: number }, signal?: AbortSignal): Promise<Summary> {
  const params = new URLSearchParams();
  if (range.from !== undefined) params.set('from', String(range.from));
  if (range.to !== undefined) params.set('to', String(range.to));
  const query = params.toString();
  return get(`/api/summary${query ? `?${query}` : ''}`, signal);
}

export function fetchTools(range: { from?: number; limit?: number }, signal?: AbortSignal): Promise<Tools> {
  const params = new URLSearchParams();
  if (range.from !== undefined) params.set('from', String(range.from));
  if (range.limit !== undefined) params.set('limit', String(range.limit));
  return get(`/api/tools?${params}`, signal);
}
