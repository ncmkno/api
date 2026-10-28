import type { ToolCall } from './api';

export interface ToolRun {
  /** The newest call of the run. */
  call: ToolCall;
  count: number;
}

// Without a detail the same tool name may be different commands, so only calls with one can repeat.
const sameCall = (a: ToolCall, b: ToolCall) =>
  a.detail !== null && a.session === b.session && a.agent === b.agent && a.tool === b.tool && a.detail === b.detail;

/** Folds back-to-back identical calls (same session, agent, tool and detail) into one run, so a looping agent shows as "×N". */
export function groupRepeats(calls: ToolCall[]): ToolRun[] {
  const runs: ToolRun[] = [];
  for (const call of calls) {
    const last = runs.at(-1);
    if (last && sameCall(last.call, call)) last.count += 1;
    else runs.push({ call, count: 1 });
  }
  return runs;
}
