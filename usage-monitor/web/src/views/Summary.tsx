import { useState } from 'react';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { BarChart } from '@mui/x-charts/BarChart';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import { fetchSettings, fetchSummary, type DayUsage, type Summary as SummaryData } from '../api';
import { HeadLabel } from '../components/HeadLabel';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { StatCard } from '../components/StatCard';
import { TableSkeleton } from '../components/TableSkeleton';
import { eachDay, formatCompact, formatDay, formatExact, formatUsd, utcDay } from '../format';
import { usePolling } from '../usePolling';

type Range = '7d' | '30d' | 'all';

const RANGES: { value: Range; label: string; days?: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: 'all', label: 'All' },
];

const DAY_MS = 86_400_000;

/** From the start of the UTC day `days - 1` days ago (so "7 days" is today plus six) up to now. */
export function rangeBounds(range: Range, now: number): { from?: number; to?: number } {
  const days = RANGES.find((r) => r.value === range)?.days;
  if (days === undefined) return {};
  return { from: Date.parse(`${utcDay(now - (days - 1) * DAY_MS)}T00:00:00Z`), to: now };
}

/** One row per day across the span, zeros where nothing was recorded, so the time axis is honest. */
function withEmptyDays(byDay: DayUsage[], range: Range, now: number): DayUsage[] {
  if (byDay.length === 0) return [];
  const sorted = [...byDay].sort((a, b) => a.day.localeCompare(b.day));
  const { from } = rangeBounds(range, now);
  const first = from === undefined ? sorted[0]!.day : utcDay(from);
  const last = range === 'all' ? sorted[sorted.length - 1]!.day : utcDay(now);
  const known = new Map(sorted.map((d) => [d.day, d]));
  return eachDay(first, last).map(
    (day) =>
      known.get(day) ?? { day, requests: 0, tools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  );
}

const DAY_TABLE_CAPTION = 'Usage per UTC day';

interface ChartCardProps {
  title: string;
  note: string;
  /** One entry per series: a key in the card header instead of the chart's own legend, so both plots line up. */
  legend?: { label: string; color: string }[];
  children: React.ReactNode;
}

function ChartCard({ title, note, legend, children }: ChartCardProps) {
  return (
    <Paper className="p-4">
      {/* The legend wraps under the title when both do not fit, instead of squeezing it. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <Typography variant="h2" component="h2">
            {title}
          </Typography>
          <Typography variant="caption" color="textSecondary" component="p" className="mt-0.5">
            {note}
          </Typography>
        </div>
        {legend && (
          <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs text-fg-muted">
            {legend.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span aria-hidden className="size-2.5 rounded-xs" style={{ background: item.color }} />
                {item.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-2" role="img" aria-label={`${title}, bar chart. The values are in the table "${DAY_TABLE_CAPTION}".`}>
        {children}
      </div>
    </Paper>
  );
}

// Axis text and rules in the theme's muted colours rather than the chart library's defaults.
const chartSx = {
  '&& .MuiChartsAxis-tickLabel': { fill: 'var(--mui-palette-text-secondary)' },
  '&& .MuiChartsAxis-line, && .MuiChartsAxis-tick': { stroke: 'var(--mui-palette-divider)' },
  '&& .MuiChartsGrid-line': { stroke: 'var(--mui-palette-divider)' },
};

/** The charts' values as text, for screen readers; the charts themselves only show them on hover. */
function DayTable({ days }: { days: DayUsage[] }) {
  return (
    <div className="sr-only">
      <table>
        <caption>{DAY_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Est. cost</th>
            <th scope="col">New in</th>
            <th scope="col">Out</th>
            <th scope="col">Cache write</th>
            <th scope="col">Cache read</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}>
              <th scope="row">{formatDay(d.day)}</th>
              <td>{formatUsd(d.costUsd)}</td>
              <td>{formatExact(d.input)}</td>
              <td>{formatExact(d.output)}</td>
              <td>{formatExact(d.cacheWrite)}</td>
              <td>{formatExact(d.cacheRead)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayCharts({ days, budget }: { days: DayUsage[]; budget: number | null }) {
  const theme = useTheme();
  const palette = theme.vars?.palette ?? theme.palette;
  const accent = palette.accentFill;
  const support = palette.secondary.main;
  // Cache traffic is the bulk of the tokens but the cheap part: it stays quiet beside new input and output.
  const cacheWrite = palette.success.main;
  const cacheRead = palette.text.disabled;
  const axis = [
    {
      scaleType: 'band' as const,
      data: days.map((d) => d.day),
      valueFormatter: (day: string) => formatDay(day),
      tickLabelStyle: { fontSize: 11 },
      // Labels that would collide at the chart's actual width are skipped, for 7 days on a phone as for 30 on a desktop.
      tickLabelInterval: 'auto' as const,
      tickLabelMinGap: 10,
    },
  ];
  const common = {
    height: 240,
    skipAnimation: true,
    hideLegend: true,
    xAxis: axis,
    grid: { horizontal: true },
    sx: chartSx,
    margin: { left: 8, right: 8, top: 16, bottom: 8 },
  };

  return (
    <div className="relative grid grid-cols-1 gap-3 lg:grid-cols-2">
      <ChartCard
        title="Cost per day"
        note={`Estimated (est.), USD, UTC days${budget === null ? '' : `; dashed line: ${formatUsd(budget)} daily budget`}`}
      >
        <BarChart
          {...common}
          series={[
            {
              data: days.map((d) => d.costUsd ?? 0),
              label: 'Est. cost',
              color: accent,
              valueFormatter: (v) => formatUsd(v),
            },
          ]}
          // The axis reaches past the budget, so its line stays on the chart on a cheap day.
          yAxis={[
            {
              valueFormatter: (v: number) => formatUsd(v),
              width: 64,
              ...(budget === null ? {} : { max: Math.max(budget, ...days.map((d) => d.costUsd ?? 0)) * 1.1 }),
            },
          ]}
        >
          {budget !== null && (
            <ChartsReferenceLine y={budget} lineStyle={{ strokeDasharray: '4 4', stroke: palette.warning.main }} />
          )}
        </BarChart>
      </ChartCard>
      <ChartCard
        title="Tokens per day"
        note="Every token type; cache reads are billed at a tenth of the new-input price"
        legend={[
          { label: 'New in', color: accent },
          { label: 'Out', color: support },
          { label: 'Cache write', color: cacheWrite },
          { label: 'Cache read', color: cacheRead },
        ]}
      >
        <BarChart
          {...common}
          series={[
            { data: days.map((d) => d.input), label: 'New in', stack: 'tokens', color: accent, valueFormatter: (v) => formatExact(v) },
            { data: days.map((d) => d.output), label: 'Out', stack: 'tokens', color: support, valueFormatter: (v) => formatExact(v) },
            {
              data: days.map((d) => d.cacheWrite),
              label: 'Cache write',
              stack: 'tokens',
              color: cacheWrite,
              valueFormatter: (v) => formatExact(v),
            },
            {
              data: days.map((d) => d.cacheRead),
              label: 'Cache read',
              stack: 'tokens',
              color: cacheRead,
              valueFormatter: (v) => formatExact(v),
            },
          ]}
          yAxis={[{ valueFormatter: (v: number) => formatCompact(v), width: 48 }]}
        />
      </ChartCard>
      <DayTable days={days} />
    </div>
  );
}

function ModelTable({ byModel, totalCost }: { byModel: SummaryData['byModel']; totalCost: number }) {
  const rows = [...byModel].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.requests - a.requests);
  return (
    <Paper>
      <TableContainer>
        <Table size="small" aria-label="Usage by model">
          <TableHead>
            <TableRow>
              <TableCell>Model</TableCell>
              <TableCell align="right">
                <HeadLabel short="Req." long="Requests" />
              </TableCell>
              <TableCell align="right" className="hidden sm:table-cell">
                New in
              </TableCell>
              <TableCell align="right" className="hidden sm:table-cell">
                Out
              </TableCell>
              <TableCell align="right" className="hidden md:table-cell">
                Cache read
              </TableCell>
              <TableCell align="right" className="hidden md:table-cell">
                Cache write
              </TableCell>
              <TableCell align="right">
                <HeadLabel short="Est. $" long="Est. cost" />
              </TableCell>
              <TableCell className="hidden w-40 lg:table-cell">Share of est. cost</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((m) => {
              const share = totalCost > 0 && m.costUsd ? (m.costUsd / totalCost) * 100 : 0;
              return (
                <TableRow key={m.model}>
                  <TableCell className="max-w-[16rem]">
                    <div className="truncate font-mono text-[0.8125rem]" title={m.model}>
                      {m.model}
                    </div>
                  </TableCell>
                  <TableCell align="right" title={formatExact(m.requests)}>
                    {formatCompact(m.requests)}
                  </TableCell>
                  <TableCell align="right" className="hidden sm:table-cell" title={formatExact(m.input)}>
                    {formatCompact(m.input)}
                  </TableCell>
                  <TableCell align="right" className="hidden sm:table-cell" title={formatExact(m.output)}>
                    {formatCompact(m.output)}
                  </TableCell>
                  <TableCell align="right" className="hidden md:table-cell" title={formatExact(m.cacheRead)}>
                    {formatCompact(m.cacheRead)}
                  </TableCell>
                  <TableCell align="right" className="hidden md:table-cell" title={formatExact(m.cacheWrite)}>
                    {formatCompact(m.cacheWrite)}
                  </TableCell>
                  <TableCell align="right" className="font-medium whitespace-nowrap">
                    {formatUsd(m.costUsd)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <div className="flex items-center gap-2">
                      <span aria-hidden className="h-2 flex-1 overflow-hidden rounded-sm bg-panel-2">
                        <span className="block h-full rounded-sm bg-accent-fill" style={{ width: `${share}%` }} />
                      </span>
                      <span className="w-9 text-right text-xs text-fg-muted tabular-nums">{Math.round(share)}%</span>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

function totalsOf(summary: SummaryData) {
  return summary.byDay.reduce(
    (t, d) => ({
      cost: d.costUsd === null ? t.cost : (t.cost ?? 0) + d.costUsd,
      requests: t.requests + d.requests,
      tools: t.tools + d.tools,
      input: t.input + d.input,
      output: t.output + d.output,
    }),
    { cost: null as number | null, requests: 0, tools: 0, input: 0, output: 0 },
  );
}

export function Summary() {
  const [range, setRange] = useState<Range>('7d');
  const { data, error, fetching, loading, retry } = usePolling(`summary:${range}`, (signal) =>
    fetchSummary(rangeBounds(range, Date.now()), signal),
  );

  const empty = data !== undefined && data.byDay.length === 0 && data.byModel.length === 0;
  const totals = data && totalsOf(data);
  const settings = usePolling('summary-settings', (signal) => fetchSettings(signal), 60_000);
  const budget = typeof settings.data?.dailyBudgetUsd === 'number' ? settings.data.dailyBudgetUsd : null;
  const rangeLabel = RANGES.find((r) => r.value === range)!.label.toLowerCase();

  // The window of the same length just before this one, for the cards' comparisons.
  const days = RANGES.find((r) => r.value === range)!.days;
  const prevData = usePolling(`summary-previous:${range}`, (signal) => {
    if (days === undefined) return Promise.resolve(null);
    const { from } = rangeBounds(range, Date.now());
    return fetchSummary({ from: from! - days * DAY_MS, to: from! - 1 }, signal);
  }).data;
  const previous = prevData === undefined ? undefined : prevData === null ? null : totalsOf(prevData);
  const prevLabel = `previous ${days} days`;
  const compare = (now: number, before: number, format: (n: number) => string): string | undefined => {
    if (previous === undefined || days === undefined) return undefined;
    if (previous === null || (previous.requests === 0 && previous.tools === 0 && previous.cost === null)) return `Nothing in ${prevLabel}`;
    const delta = now - before;
    if (delta === 0) return `Same as ${prevLabel}`;
    return `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))} vs ${prevLabel}`;
  };

  return (
    <section className="flex flex-col gap-6" aria-labelledby="summary-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Typography variant="h1" id="summary-title">
            Summary
          </Typography>
          <Typography color="textSecondary" className="mt-1">
            Usage per UTC day and per model. Costs are estimates (est.).
          </Typography>
        </div>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={range}
          aria-label="Time range"
          onChange={(_, next: Range | null) => next && setRange(next)}
        >
          {RANGES.map((r) => (
            <ToggleButton key={r.value} value={r.value} sx={{ '@media (pointer: coarse)': { minHeight: 44 } }}>
              {r.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      {error !== undefined && <ErrorState onRetry={retry} busy={fetching} stale={data !== undefined} />}

      {loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} variant="rounded" height={88} />
            ))}
          </div>
          <Skeleton variant="rounded" height={300} />
          <TableSkeleton rows={3} />
        </>
      )}

      {empty &&
        (range === 'all' ? (
          <EmptyState title="No usage yet" />
        ) : (
          <EmptyState title="No usage in this range">Nothing was recorded in {rangeLabel}. Try a longer range.</EmptyState>
        ))}

      {data && !empty && totals && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              lead
              label="Est. cost"
              value={formatUsd(totals.cost)}
              hint={
                range === 'all'
                  ? totals.cost === null
                    ? undefined
                    : `Avg ${formatUsd(totals.cost / withEmptyDays(data.byDay, range, Date.now()).length)} a day`
                  : compare(totals.cost ?? 0, previous?.cost ?? 0, formatUsd)
              }
            />
            <StatCard
              label="Requests"
              value={formatCompact(totals.requests)}
              title={formatExact(totals.requests)}
              hint={range === 'all' ? undefined : compare(totals.requests, previous?.requests ?? 0, formatExact)}
            />
            <StatCard
              label="Tool calls"
              value={formatCompact(totals.tools)}
              title={formatExact(totals.tools)}
              hint={range === 'all' ? undefined : compare(totals.tools, previous?.tools ?? 0, formatExact)}
            />
            <StatCard
              label="New tokens"
              value={formatCompact(totals.input + totals.output)}
              title={formatExact(totals.input + totals.output)}
              hint={`${formatCompact(totals.input)} in · ${formatCompact(totals.output)} out`}
            />
          </div>
          <DayCharts days={withEmptyDays(data.byDay, range, Date.now())} budget={budget} />
          <div className="flex flex-col gap-2">
            <Typography variant="h2" component="h2">
              By model
            </Typography>
            <ModelTable byModel={data.byModel} totalCost={totals.cost ?? 0} />
          </div>
        </>
      )}
    </section>
  );
}
