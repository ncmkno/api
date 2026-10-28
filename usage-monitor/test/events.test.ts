import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseBatch, ValidationError } from '../src/events.ts';

type Raw = Record<string, unknown>;

const usage = (over: Raw = {}): Raw => ({
  id: 'u-1', v: 1, type: 'usage', session: 's-1', ts: 1_700_000_000_000,
  agent: 'main', model: 'claude-x', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5, ...over,
});
const tool = (over: Raw = {}): Raw => ({
  id: 't-1', v: 1, type: 'tool', session: 's-1', ts: 1_700_000_000_000, agent: 'main', tool: 'Bash', ...over,
});
const agent = (over: Raw = {}): Raw => ({
  id: 'a-1', v: 1, type: 'agent', session: 's-1', ts: 1_700_000_000_000, agent: 'sub-1', label: 'explore', ...over,
});
const session = (over: Raw = {}): Raw => ({
  id: 'e-1', v: 1, type: 'session', session: 's-1', ts: 1_700_000_000_000, state: 'start', ...over,
});

function without(event: Raw, key: string): Raw {
  const copy = { ...event };
  delete copy[key];
  return copy;
}

// The batch is rejected, and the error names the event at `index` and the failing field.
function assertInvalid(events: unknown[], index: number, field: string): void {
  assert.throws(
    () => parseBatch({ events }),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError, 'expected a ValidationError');
      assert.equal(error.index, index);
      assert.equal(error.field, field);
      assert.ok(error.message.includes(`events[${index}].${field}`), error.message);
      return true;
    },
  );
}

function assertValid(event: Raw): void {
  assert.equal(parseBatch({ events: [event] }).length, 1);
}

describe('batch shape', () => {
  test('a mixed batch parses and drops v and unknown extra fields', () => {
    const parsed = parseBatch({ events: [usage({ extra: 'x' }), tool(), agent({ model: 'm' }), session({ cwd: '/w' })], other: 1 });
    assert.deepEqual(parsed, [
      { id: 'u-1', session: 's-1', ts: 1_700_000_000_000, type: 'usage', agent: 'main', model: 'claude-x', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5 },
      { id: 't-1', session: 's-1', ts: 1_700_000_000_000, type: 'tool', agent: 'main', tool: 'Bash' },
      { id: 'a-1', session: 's-1', ts: 1_700_000_000_000, type: 'agent', agent: 'sub-1', label: 'explore', model: 'm' },
      { id: 'e-1', session: 's-1', ts: 1_700_000_000_000, type: 'session', state: 'start', cwd: '/w' },
    ]);
  });

  for (const body of [null, 7, 'x', [], [usage()], {}, { events: 'nope' }, { events: {} }]) {
    test(`body ${JSON.stringify(body)} is rejected`, () => {
      assert.throws(() => parseBatch(body), ValidationError);
    });
  }

  test('an empty batch is rejected', () => {
    assert.throws(() => parseBatch({ events: [] }), /events: must hold 1 to 500 events/);
  });

  test('500 events are accepted and 501 are rejected', () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => usage({ id: `u-${i}` }));
    assert.equal(parseBatch({ events: batch(500) }).length, 500);
    assert.throws(() => parseBatch({ events: batch(501) }), /events: must hold 1 to 500 events/);
  });

  for (const event of [null, 3, 'usage', [usage()]]) {
    test(`an event that is ${JSON.stringify(event)} is rejected`, () => {
      assertInvalid([usage(), event], 1, '(event)');
    });
  }

  test('the error names the index of the failing event within the batch', () => {
    assertInvalid([usage(), tool(), usage({ id: 'u-3', costUsd: -1 })], 2, 'costUsd');
  });
});

describe('common fields', () => {
  for (const make of [usage, tool, agent, session]) {
    const type = String(make().type);

    test(`${type}: id must be a string of 1 to 64 characters`, () => {
      for (const bad of [undefined, 7, null, '', 'x'.repeat(65)]) assertInvalid([make({ id: bad })], 0, 'id');
      assertValid(make({ id: 'x' }));
      assertValid(make({ id: 'x'.repeat(64) }));
    });

    test(`${type}: v must be the number 1`, () => {
      for (const bad of [undefined, 2, '1', true, null]) assertInvalid([make({ v: bad })], 0, 'v');
    });

    test(`${type}: session must be a string of 1 to 64 characters`, () => {
      for (const bad of [undefined, 7, '', 'x'.repeat(65)]) assertInvalid([make({ session: bad })], 0, 'session');
      assertValid(make({ session: 'x'.repeat(64) }));
    });

    test(`${type}: ts must be an integer`, () => {
      for (const bad of [undefined, '1700000000000', 1.5, null, 1e21, true]) assertInvalid([make({ ts: bad })], 0, 'ts');
      assertValid(make({ ts: 0 }));
    });

    // SQLite's date() is NULL outside years 0000-9999, and the summary groups by that day.
    test(`${type}: ts must lie between 0 and 253402300799999 (9999-12-31T23:59:59.999Z)`, () => {
      for (const bad of [-1, -1_700_000_000_000, 253402300800000, 300000000000000, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
        assertInvalid([make({ ts: bad })], 0, 'ts');
      }
      assertValid(make({ ts: 253402300799999 }));
      assertValid(make({ ts: Date.UTC(1970, 0, 1) }));
    });
  }

  test('type must be one of the four known types', () => {
    for (const bad of [undefined, 'other', 'USAGE', 7, null]) assertInvalid([usage({ type: bad })], 0, 'type');
  });
});

describe('usage events', () => {
  test('agent must be a string of 1 to 64 characters', () => {
    for (const bad of [undefined, 7, '', 'x'.repeat(65)]) assertInvalid([usage({ agent: bad })], 0, 'agent');
    assertValid(usage({ agent: 'x'.repeat(64) }));
  });

  test('model must be a string of 1 to 100 characters', () => {
    for (const bad of [undefined, 7, '', 'x'.repeat(101)]) assertInvalid([usage({ model: bad })], 0, 'model');
    assertValid(usage({ model: 'x'.repeat(100) }));
  });

  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    test(`${field} must be a non-negative integer`, () => {
      for (const bad of [undefined, null, '5', -1, 1.5, 1e21, true]) assertInvalid([usage({ [field]: bad })], 0, field);
      assertInvalid([without(usage(), field)], 0, field);
      assertValid(usage({ [field]: 0 }));
    });
  }

  test('costUsd must be a number >= 0 or null, and must be present', () => {
    for (const bad of [undefined, '0.5', -0.01, true, {}]) assertInvalid([usage({ costUsd: bad })], 0, 'costUsd');
    assertInvalid([without(usage(), 'costUsd')], 0, 'costUsd');
    assertInvalid([JSON.parse('{"id":"u","v":1,"type":"usage","session":"s","ts":1,"agent":"main","model":"m","input":0,"output":0,"cacheRead":0,"cacheWrite":0,"costUsd":1e999}')], 0, 'costUsd');
    for (const good of [0, 0.000123, 12.5, null]) assertValid(usage({ costUsd: good }));
  });

  test('a null costUsd is kept as null', () => {
    assert.equal((parseBatch({ events: [usage({ costUsd: null })] })[0] as { costUsd: unknown }).costUsd, null);
  });
});

describe('tool events', () => {
  test('agent must be a string of 1 to 64 characters', () => {
    for (const bad of [undefined, 7, '', 'x'.repeat(65)]) assertInvalid([tool({ agent: bad })], 0, 'agent');
  });

  test('tool must be a string of 1 to 200 characters', () => {
    for (const bad of [undefined, 7, '', 'x'.repeat(201)]) assertInvalid([tool({ tool: bad })], 0, 'tool');
    assertValid(tool({ tool: 'x'.repeat(200) }));
  });
});

describe('agent events', () => {
  test('agent must be a string of 1 to 64 characters', () => {
    for (const bad of [undefined, 7, '', 'x'.repeat(65)]) assertInvalid([agent({ agent: bad })], 0, 'agent');
  });

  test('label must be a string of 0 to 300 characters, and must be present', () => {
    for (const bad of [undefined, 7, null, 'x'.repeat(301)]) assertInvalid([agent({ label: bad })], 0, 'label');
    assertValid(agent({ label: '' }));
    assertValid(agent({ label: 'x'.repeat(300) }));
  });

  test('model is optional but must be a string when present', () => {
    for (const bad of [7, null, true]) assertInvalid([agent({ model: bad })], 0, 'model');
    assertValid(agent());
    assertValid(agent({ model: 'claude-x' }));
  });

  test('model is at most 100 characters, like the usage event model', () => {
    assertInvalid([agent({ model: 'x'.repeat(101) })], 0, 'model');
    assertValid(agent({ model: 'x'.repeat(100) }));
    assertValid(agent({ model: '' }));
  });
});

describe('session events', () => {
  test('state must be start, end or clear', () => {
    for (const bad of [undefined, 'begin', 'START', 7, null]) assertInvalid([session({ state: bad })], 0, 'state');
    for (const good of ['start', 'end', 'clear']) assertValid(session({ state: good }));
  });

  test('a tool detail is optional, a string of at most 300 characters when present', () => {
    for (const bad of [7, null, {}, 'x'.repeat(301)]) assertInvalid([tool({ detail: bad })], 0, 'detail');
    assertValid(tool({ detail: 'npm test' }));
    assertValid(tool({ detail: 'x'.repeat(300) }));
    assert.equal((parseBatch({ events: [tool({ detail: 'ls' })] })[0] as Raw).detail, 'ls');
  });

  test('cwd is optional but must be a string when present', () => {
    for (const bad of [7, null, {}]) assertInvalid([session({ cwd: bad })], 0, 'cwd');
    assertValid(session());
    assertValid(session({ cwd: '/home/me/project' }));
  });

  test('cwd is at most 4096 characters', () => {
    assertInvalid([session({ cwd: '/'.repeat(4097) })], 0, 'cwd');
    assertValid(session({ cwd: '/'.repeat(4096) }));
    assertValid(session({ cwd: '' }));
  });
});
