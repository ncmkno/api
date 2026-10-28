const MAX_EVENTS_PER_BATCH = 500;
const MAX_DETAIL_LENGTH = 300;
const MAX_CWD_LENGTH = 4096; // PATH_MAX
const MAX_MODEL_LENGTH = 100;
// 9999-12-31T23:59:59.999Z: the last instant SQLite's date() can format, so every stored ts has a day.
const MAX_TS = 253402300799999;
const SESSION_STATES = ['start', 'end', 'clear'];

type Base = { id: string; session: string; ts: number };

export type UsageEvent = Base & {
  type: 'usage';
  agent: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
};
export type ToolEvent = Base & { type: 'tool'; agent: string; tool: string; detail?: string };
export type AgentEvent = Base & { type: 'agent'; agent: string; label: string; model?: string };
export type SessionEvent = Base & { type: 'session'; state: string; cwd?: string };
export type MonitorEvent = UsageEvent | ToolEvent | AgentEvent | SessionEvent;

export class ValidationError extends Error {
  readonly index: number | null;
  readonly field: string;

  constructor(index: number | null, field: string, problem: string) {
    super(index === null ? `${field}: ${problem}` : `events[${index}].${field}: ${problem}`);
    this.name = 'ValidationError';
    this.index = index;
    this.field = field;
  }
}

export function parseBatch(body: unknown): MonitorEvent[] {
  if (!isRecord(body)) throw new ValidationError(null, 'body', 'must be a JSON object with an "events" array');
  const { events } = body;
  if (!Array.isArray(events)) throw new ValidationError(null, 'events', 'must be an array');
  if (events.length < 1 || events.length > MAX_EVENTS_PER_BATCH) {
    throw new ValidationError(null, 'events', `must hold 1 to ${MAX_EVENTS_PER_BATCH} events`);
  }
  return events.map(parseEvent);
}

function parseEvent(raw: unknown, index: number): MonitorEvent {
  if (!isRecord(raw)) throw new ValidationError(index, '(event)', 'must be an object');
  const read = fieldReader(raw, index);
  const base: Base = {
    id: read.string('id', 1, 64),
    session: read.string('session', 1, 64),
    ts: read.timestamp('ts'),
  };
  if (raw.v !== 1) throw new ValidationError(index, 'v', 'must be the number 1');

  switch (raw.type) {
    case 'usage':
      return {
        ...base,
        type: 'usage',
        agent: read.string('agent', 1, 64),
        model: read.string('model', 1, MAX_MODEL_LENGTH),
        input: read.nonNegativeInteger('input'),
        output: read.nonNegativeInteger('output'),
        cacheRead: read.nonNegativeInteger('cacheRead'),
        cacheWrite: read.nonNegativeInteger('cacheWrite'),
        costUsd: read.costUsd('costUsd'),
      };
    case 'tool':
      return {
        ...base,
        type: 'tool',
        agent: read.string('agent', 1, 64),
        tool: read.string('tool', 1, 200),
        ...read.optionalString('detail', MAX_DETAIL_LENGTH),
      };
    case 'agent':
      return {
        ...base,
        type: 'agent',
        agent: read.string('agent', 1, 64),
        label: read.string('label', 0, 300),
        ...read.optionalString('model', MAX_MODEL_LENGTH),
      };
    case 'session':
      return {
        ...base,
        type: 'session',
        state: read.oneOf('state', SESSION_STATES),
        ...read.optionalString('cwd', MAX_CWD_LENGTH),
      };
    default:
      throw new ValidationError(index, 'type', 'must be "usage", "tool", "agent" or "session"');
  }
}

// Each reader returns the validated value or throws a ValidationError naming the event and field.
function fieldReader(event: Record<string, unknown>, index: number) {
  const fail = (field: string, problem: string): never => {
    throw new ValidationError(index, field, problem);
  };
  const string = (field: string, min: number, max: number): string => {
    const value = event[field];
    if (typeof value !== 'string') return fail(field, 'must be a string');
    if (value.length < min || value.length > max) return fail(field, `must be ${min} to ${max} characters`);
    return value;
  };
  const integer = (field: string): number => {
    const value = event[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(field, 'must be an integer');
    return value;
  };
  const timestamp = (field: string): number => {
    const value = integer(field);
    return value >= 0 && value <= MAX_TS ? value : fail(field, `must be an integer from 0 to ${MAX_TS}`);
  };
  const nonNegativeInteger = (field: string): number => {
    const value = integer(field);
    return value >= 0 ? value : fail(field, 'must be a non-negative integer');
  };
  const costUsd = (field: string): number | null => {
    const value = event[field];
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return fail(field, 'must be a number >= 0, or null');
    }
    return value;
  };
  const oneOf = (field: string, allowed: string[]): string => {
    const value = event[field];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return fail(field, `must be one of ${allowed.map((option) => `"${option}"`).join(', ')}`);
    }
    return value;
  };
  const optionalString = (field: string, max: number): Record<string, string> => {
    if (event[field] === undefined) return {};
    return { [field]: string(field, 0, max) };
  };
  return { string, timestamp, nonNegativeInteger, costUsd, oneOf, optionalString };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
