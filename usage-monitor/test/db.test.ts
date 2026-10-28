import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { checkSocketDirectory, ConfigError, dbPath, projectDir, schemaPath, socketPath } from '../src/config.ts';
import { ensureSchema, inTransaction, openDb } from '../src/db.ts';

const scratchDirs: string[] = [];
after(() => scratchDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-db-'));
  scratchDirs.push(dir);
  return dir;
}

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tableNames = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);

const insertUsage = (db: DatabaseSync, eventId: string, costUsd: number | null = null) =>
  db.prepare(`INSERT OR IGNORE INTO usage_event VALUES (?, 's', 'main', 1, 'm', 1, 1, 1, 1, ?)`).run(eventId, costUsd);

describe('schema', () => {
  test('an empty database gets every table and user_version 2', () => {
    const db = openDb(':memory:');
    assert.equal(userVersion(db), 2);
    assert.deepEqual(tableNames(db), ['agent', 'session', 'state_event', 'tool_call', 'usage_event']);
    db.close();
  });

  test('a version 1 database gains tool_call.detail and keeps its rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
    db.exec(`INSERT INTO tool_call (event_id, session, agent, ts, tool) VALUES ('t-1', 's', 'main', 1, 'Bash')`);
    assert.equal(userVersion(db), 1);
    ensureSchema(db);
    assert.equal(userVersion(db), 2);
    assert.deepEqual({ ...(db.prepare('SELECT tool, detail FROM tool_call').get() as object) }, { tool: 'Bash', detail: null });
    db.close();
  });

  test('the schema is applied once: a second pass neither fails nor wipes data', () => {
    const db = openDb(':memory:');
    insertUsage(db, 'e-1');
    ensureSchema(db);
    ensureSchema(db);
    assert.equal(userVersion(db), 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM usage_event').get() as { n: number }).n, 1);
    db.close();
  });

  test('reopening a database file keeps its data and does not apply the schema again', () => {
    const file = path.join(scratchDir(), 'nested', 'usage.db');
    const first = openDb(file);
    insertUsage(first, 'e-1');
    first.close();

    const second = openDb(file);
    assert.equal(userVersion(second), 2);
    assert.equal((second.prepare('SELECT count(*) AS n FROM usage_event').get() as { n: number }).n, 1);
    second.close();
  });

  test('a file database runs in WAL mode with a 5 s busy timeout', () => {
    const db = openDb(path.join(scratchDir(), 'usage.db'));
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
    db.close();
  });

  test('the data directory is created owner-only', () => {
    const dir = path.join(scratchDir(), 'data');
    openDb(path.join(dir, 'usage.db')).close();
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  test('two processes opening a fresh database at once apply the schema once and both succeed', { timeout: 30_000 }, async () => {
    const file = path.join(scratchDir(), 'race.db');
    // This process is the first opener: it takes the write lock and keeps it while the second process starts up.
    const first = new DatabaseSync(file);
    first.exec('PRAGMA busy_timeout = 5000');
    first.exec('BEGIN IMMEDIATE');
    const dbModule = pathToFileURL(path.join(projectDir, 'src', 'db.ts')).href;
    const second = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      import { ensureSchema } from ${JSON.stringify(dbModule)};
      const db = new DatabaseSync(${JSON.stringify(file)});
      db.exec('PRAGMA busy_timeout = 5000');
      console.log('ready');
      ensureSchema(db);
      db.close();
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      let stderr = '';
      second.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
      const exited = once(second, 'exit');
      await once(second.stdout, 'data');
      await sleep(400); // the second process is now waiting for our lock, having (or not yet having) looked at user_version
      first.exec(fs.readFileSync(schemaPath, 'utf8'));
      first.exec('COMMIT');
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(userVersion(first), 2);
      assert.deepEqual(tableNames(first), ['agent', 'session', 'state_event', 'tool_call', 'usage_event']);
    } finally {
      second.kill();
      first.close();
    }
  });
});

describe('database file mode', () => {
  test('the file is owner-only (0600), with its WAL files, whether it is new or was created group- and world-readable', () => {
    const previousUmask = process.umask(0o022);
    try {
      const existing = path.join(scratchDir(), 'existing.db');
      fs.writeFileSync(existing, '', { mode: 0o644 });
      assert.equal(fs.statSync(existing).mode & 0o777, 0o644);
      const fresh = path.join(scratchDir(), 'fresh.db');
      for (const file of [existing, fresh]) {
        const db = openDb(file);
        insertUsage(db, 'e-1'); // the -wal and -shm files exist now
        for (const suffix of ['', '-wal', '-shm']) {
          assert.equal(fs.statSync(file + suffix).mode & 0o777, 0o600, `${path.basename(file)}${suffix}`);
        }
        db.close();
      }
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe('constraints', () => {
  test('event_id is unique: INSERT OR IGNORE skips a repeat and a plain INSERT fails', () => {
    const db = openDb(':memory:');
    assert.equal(insertUsage(db, 'e-1').changes, 1);
    assert.equal(insertUsage(db, 'e-1').changes, 0);
    const insertTool = db.prepare(`INSERT INTO tool_call (event_id, session, agent, ts, tool) VALUES ('t-1', 's', 'main', 1, 'Bash')`);
    insertTool.run();
    assert.throws(() => insertTool.run(), /UNIQUE/);
    db.close();
  });

  test('cost_usd accepts NULL, and sums skip it', () => {
    const db = openDb(':memory:');
    insertUsage(db, 'e-1', 0.5);
    insertUsage(db, 'e-2', null);
    const row = db.prepare('SELECT sum(cost_usd) AS total, count(cost_usd) AS priced FROM usage_event').get() as { total: number; priced: number };
    assert.equal(row.total, 0.5);
    assert.equal(row.priced, 1);
    db.close();
  });

  test('agent is keyed by (session, agent)', () => {
    const db = openDb(':memory:');
    const insert = db.prepare(`INSERT INTO agent (session, agent) VALUES (?, ?)`);
    insert.run('s-1', 'main');
    insert.run('s-2', 'main');
    assert.throws(() => insert.run('s-1', 'main'), /UNIQUE|PRIMARY/);
    db.close();
  });
});

describe('inTransaction', () => {
  test('commits what the work wrote and returns its result', () => {
    const db = openDb(':memory:');
    assert.equal(inTransaction(db, () => insertUsage(db, 'e-1').changes), 1);
    assert.equal((db.prepare('SELECT count(*) AS n FROM usage_event').get() as { n: number }).n, 1);
    db.close();
  });

  test('rolls back everything and rethrows when the work throws', () => {
    const db = openDb(':memory:');
    assert.throws(
      () => inTransaction(db, () => {
        insertUsage(db, 'e-1');
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((db.prepare('SELECT count(*) AS n FROM usage_event').get() as { n: number }).n, 0);
    assert.equal(db.isTransaction, false);
    db.close();
  });

  test('rethrows the original error when SQLite has already rolled the transaction back on its own', () => {
    const db = openDb(':memory:');
    insertUsage(db, 'e-1');
    assert.throws(
      () => inTransaction(db, () => {
        insertUsage(db, 'e-2');
        // OR ROLLBACK ends the whole transaction inside SQLite, as SQLITE_FULL and SQLITE_IOERR do
        db.prepare(`INSERT OR ROLLBACK INTO usage_event VALUES ('e-1', 's', 'main', 1, 'm', 1, 1, 1, 1, NULL)`).run();
      }),
      /UNIQUE/,
    );
    assert.equal(db.isTransaction, false);
    assert.equal((db.prepare('SELECT count(*) AS n FROM usage_event').get() as { n: number }).n, 1);
    db.close();
  });
});

describe('paths from the environment', () => {
  test('the socket defaults to usage-monitor.sock in XDG_RUNTIME_DIR', () => {
    assert.equal(socketPath({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/usage-monitor.sock');
  });

  test('USAGE_MONITOR_SOCKET overrides the default', () => {
    assert.equal(socketPath({ USAGE_MONITOR_SOCKET: '/tmp/x.sock', XDG_RUNTIME_DIR: '/run/user/1000' }), '/tmp/x.sock');
  });

  test('with neither variable set there is no socket path: a one-line ConfigError', () => {
    for (const env of [{}, { XDG_RUNTIME_DIR: '' }]) {
      assert.throws(
        () => socketPath(env),
        (error: Error) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, /USAGE_MONITOR_SOCKET/);
          assert.ok(!error.message.includes('\n'));
          return true;
        },
      );
    }
  });

  test('the database defaults to data/usage.db in the project, and USAGE_MONITOR_DB overrides it', () => {
    assert.equal(dbPath({}), path.join(projectDir, 'data', 'usage.db'));
    assert.equal(dbPath({ USAGE_MONITOR_DB: '/tmp/x.db' }), '/tmp/x.db');
  });
});

describe('the socket directory', () => {
  const socketIn = (dir: string) => path.join(dir, 'usage-monitor.sock');
  const refusal = (socket: string): ConfigError => {
    try {
      checkSocketDirectory(socket);
    } catch (error) {
      assert.ok(error instanceof ConfigError, String(error));
      return error;
    }
    return assert.fail(`${path.dirname(socket)} was accepted`);
  };

  test('a directory of the user that others cannot write to is accepted', () => {
    const dir = scratchDir(); // mkdtemp: owned by this user, 0700
    checkSocketDirectory(socketIn(dir));
    for (const mode of [0o750, 0o755]) {
      fs.chmodSync(dir, mode);
      checkSocketDirectory(socketIn(dir));
    }
  });

  test('a group- or world-writable directory is refused with a one-line ConfigError naming it, its mode and the requirement', () => {
    const dir = scratchDir();
    for (const mode of [0o777, 0o775, 0o757, 0o770, 0o720, 0o702]) {
      fs.chmodSync(dir, mode);
      const { message } = refusal(socketIn(dir));
      assert.ok(message.includes(dir), message);
      assert.ok(message.includes(mode.toString(8).padStart(4, '0')), message);
      assert.match(message, /\$XDG_RUNTIME_DIR/);
      assert.ok(!message.includes('\n'), message);
    }
  });

  test('a sticky world-writable directory such as /tmp is refused too', () => {
    const dir = scratchDir();
    fs.chmodSync(dir, 0o1777);
    refusal(socketIn(dir));
  });

  test('a directory of another user is refused', (t) => {
    if (process.getuid!() === 0) return t.skip('running as root: every directory is "owned" as far as root is concerned');
    assert.match(refusal('/usage-monitor.sock').message, /owned by uid 0/);
  });

  test('a symlink in place of the directory is refused, and so is a directory that does not exist', () => {
    const dir = scratchDir();
    const link = path.join(dir, 'link');
    fs.symlinkSync(dir, link);
    assert.match(refusal(socketIn(link)).message, /not a directory/);
    assert.match(refusal(socketIn(path.join(dir, 'missing'))).message, /ENOENT/);
  });
});
