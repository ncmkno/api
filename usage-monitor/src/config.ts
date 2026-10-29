import fs from 'node:fs';
import path from 'node:path';

export const projectDir = path.resolve(import.meta.dirname, '..');
export const distDir = path.join(projectDir, 'web', 'dist');
export const schemaPath = path.join(projectDir, 'schema.sql');

// A bad setting the operator has to fix; the entry point prints just the message for it.
export class ConfigError extends Error {}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.USAGE_MONITOR_SOCKET) return env.USAGE_MONITOR_SOCKET;
  if (!env.XDG_RUNTIME_DIR) {
    throw new ConfigError('Set USAGE_MONITOR_SOCKET, or XDG_RUNTIME_DIR for the default socket path');
  }
  return path.join(env.XDG_RUNTIME_DIR, 'usage-monitor.sock');
}

// The mod sends every event to whoever listens on the socket path, so the directory must be one only this user can write to:
// in a shared one (/tmp) another user could bind the path first. lstat, so a symlink in its place is refused too.
export function checkSocketDirectory(socket: string): void {
  const dir = path.dirname(socket);
  const requirement = 'it must be a directory owned by you that group and others cannot write to, such as $XDG_RUNTIME_DIR';
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    throw new ConfigError(`the socket directory ${dir} cannot be checked (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); ${requirement}`);
  }
  const mode = (stat.mode & 0o7777).toString(8).padStart(4, '0');
  if (!stat.isDirectory()) throw new ConfigError(`the socket directory ${dir} is not a directory; ${requirement}`);
  if (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) {
    throw new ConfigError(`the socket directory ${dir} is owned by uid ${stat.uid} with mode ${mode}; ${requirement}`);
  }
}

// Unset or empty: no TCP listener. 0 is not accepted here; only the programmatic entry takes it (ephemeral port).
export function tcpPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.USAGE_MONITOR_PORT;
  if (!raw) return null;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new ConfigError(`USAGE_MONITOR_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

// Unset or empty: no budget. A positive amount in USD, e.g. 20 or 7.50.
export function dailyBudget(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.USAGE_MONITOR_DAILY_BUDGET;
  if (!raw) return null;
  const amount = /^\d+(\.\d{1,2})?$/.test(raw) ? Number(raw) : NaN;
  if (!(amount > 0)) {
    throw new ConfigError(`USAGE_MONITOR_DAILY_BUDGET must be a positive amount in USD such as 20 or 7.50, got ${JSON.stringify(raw)}`);
  }
  return amount;
}

export function dbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.USAGE_MONITOR_DB || path.join(projectDir, 'data', 'usage.db');
}
