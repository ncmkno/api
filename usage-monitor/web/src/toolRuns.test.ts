import { describe, expect, it } from 'vitest';
import type { ToolCall } from './api';
import { groupRepeats } from './toolRuns';

const call = (ts: number, tool: string, detail: string | null, over: Partial<ToolCall> = {}): ToolCall => ({
  ts, tool, detail, session: 's', agent: 'main', label: '', cwd: '/w', ...over,
});

describe('groupRepeats', () => {
  it('folds back-to-back identical calls into one entry with a count, keeping the newest call', () => {
    const calls = [call(5, 'Read', 'a.ts'), call(4, 'Read', 'a.ts'), call(3, 'Read', 'a.ts'), call(2, 'Bash', 'ls'), call(1, 'Read', 'a.ts')];
    expect(groupRepeats(calls).map((r) => [r.call.ts, r.count])).toEqual([
      [5, 3],
      [2, 1],
      [1, 1], // not adjacent to the first run
    ]);
  });

  it('treats a different detail, agent or session as a different call', () => {
    const calls = [
      call(4, 'Read', 'a.ts'),
      call(3, 'Read', 'b.ts'),
      call(2, 'Read', 'b.ts', { agent: 'sub' }),
      call(1, 'Read', 'b.ts', { session: 'other', agent: 'sub' }),
    ];
    expect(groupRepeats(calls).map((r) => r.count)).toEqual([1, 1, 1, 1]);
  });

  it('never folds calls without a detail: the same tool name alone may be different commands', () => {
    expect(groupRepeats([call(3, 'Bash', null), call(2, 'Bash', null), call(1, 'Bash', null)]).map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it('is empty for no calls', () => {
    expect(groupRepeats([])).toEqual([]);
  });
});
