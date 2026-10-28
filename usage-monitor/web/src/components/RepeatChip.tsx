/** "×N" for a folded run of identical calls; three or more in a row is flagged as a likely loop. */
export function RepeatChip({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <span
      aria-label={`Repeated ${count} times`}
      title={count >= 3 ? `The same call ${count} times in a row: the agent may be looping` : `The same call ${count} times in a row`}
      className={`shrink-0 rounded px-1 text-[0.6875rem] font-semibold tabular-nums ${
        count >= 3 ? 'bg-[#ff9f0a]/15 text-[#ff9f0a]' : 'bg-current/10'
      }`}
    >
      ×{count}
    </span>
  );
}
