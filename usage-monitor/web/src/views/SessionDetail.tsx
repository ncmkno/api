import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { ApiError, fetchSession, fetchTools, type AgentUsage } from '../api';
import { ErrorState } from '../components/ErrorState';
import { RepeatChip } from '../components/RepeatChip';
import { HeadLabel } from '../components/HeadLabel';
import { StatCard } from '../components/StatCard';
import { TableSkeleton } from '../components/TableSkeleton';
import { formatCompact, formatDateTime, formatExact, formatUsd, shortenPath } from '../format';
import { hrefs } from '../route';
import { groupRepeats } from '../toolRuns';
import { usePolling } from '../usePolling';

const byCostDesc = (a: AgentUsage, b: AgentUsage) =>
  (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.requests - a.requests;

function BackLink() {
  return (
    <Link href={hrefs.sessions} underline="hover" className="inline-flex items-center gap-1 text-sm">
      <span aria-hidden>←</span> All sessions
    </Link>
  );
}

const TIMELINE_LIMIT = 200;

/** The session's tool calls newest first, back-to-back repeats folded into one row. */
function Timeline({ id }: { id: string }) {
  const { data } = usePolling(`session-tools:${id}`, (signal) => fetchTools({ session: id, limit: TIMELINE_LIMIT }, signal));
  const runs = groupRepeats(data?.calls ?? []);
  if (runs.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <Typography variant="h2" component="h2">
        Timeline
      </Typography>
      <Paper>
        <ul aria-label="Timeline" className="m-0 max-h-[28rem] list-none overflow-y-auto p-0">
          {runs.map(({ call: c, count }, i) => (
            <li
              key={`${c.ts}:${i}`}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-3 border-b border-line px-4 py-2 last:border-b-0 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,10rem)]"
            >
              <span className="text-xs whitespace-nowrap text-fg-muted tabular-nums">{formatDateTime(c.ts)}</span>
              <span className="min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-[0.8125rem]">{c.tool}</span>
                  <RepeatChip count={count} />
                </span>
                {c.detail && (
                  <span className="block truncate font-mono text-xs text-fg-muted" title={c.detail}>
                    {c.detail}
                  </span>
                )}
              </span>
              <span className="hidden truncate text-xs text-fg-muted sm:block" title={c.label || c.agent}>
                {c.label || c.agent}
              </span>
            </li>
          ))}
        </ul>
      </Paper>
    </div>
  );
}

export function SessionDetail({ id }: { id: string }) {
  const { data, error, fetching, loading, retry } = usePolling(`session:${id}`, (signal) => fetchSession(id, signal));
  const notFound = error instanceof ApiError && error.status === 404;

  if (notFound) {
    return (
      <section className="flex flex-col gap-4">
        <BackLink />
        <Alert severity="info" variant="outlined">
          <AlertTitle>Session not found</AlertTitle>
          No session with this id is stored. It may have been removed.
        </Alert>
      </section>
    );
  }

  const agents = data ? [...data.agents].sort(byCostDesc) : [];
  const tools = data ? [...data.tools].sort((a, b) => b.count - a.count) : [];
  const maxCount = tools[0]?.count ?? 0;
  const toolTotal = tools.reduce((sum, t) => sum + t.count, 0);

  return (
    <section className="flex flex-col gap-6" aria-labelledby="session-title">
      <div className="flex flex-col gap-3">
        <BackLink />
        {data ? (
          <div>
            <Typography variant="h1" id="session-title" title={data.cwd ?? undefined} className="break-words">
              {shortenPath(data.cwd)}
            </Typography>
            <Typography color="textSecondary" className="mt-1">
              Started {formatDateTime(data.startedTs)} · last activity {formatDateTime(data.lastTs)}
            </Typography>
            <Typography variant="caption" color="textSecondary" className="mt-0.5 block break-all font-mono">
              {data.session}
            </Typography>
          </div>
        ) : (
          <div>
            <Typography variant="h1" id="session-title">
              Session
            </Typography>
            <Typography variant="caption" color="textSecondary" className="mt-0.5 block break-all font-mono">
              {id}
            </Typography>
          </div>
        )}
      </div>

      {error !== undefined && <ErrorState onRetry={retry} busy={fetching} stale={data !== undefined} />}

      {loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 7 }, (_, i) => (
              <Skeleton key={i} variant="rounded" height={88} className={i === 0 ? 'col-span-2' : ''} />
            ))}
          </div>
          <TableSkeleton rows={3} />
        </>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard lead className="col-span-2" label="Est. cost" value={formatUsd(data.costUsd)} hint="Estimated from list prices" />
            <StatCard label="Requests" value={formatCompact(data.requests)} title={formatExact(data.requests)} />
            <StatCard label="Tool calls" value={formatCompact(toolTotal)} title={formatExact(toolTotal)} />
            <StatCard label="New in" value={formatCompact(data.input)} title={formatExact(data.input)} hint="tokens" />
            <StatCard label="Out" value={formatCompact(data.output)} title={formatExact(data.output)} hint="tokens" />
            <StatCard label="Cache read" value={formatCompact(data.cacheRead)} title={formatExact(data.cacheRead)} hint="tokens" />
            <StatCard label="Cache write" value={formatCompact(data.cacheWrite)} title={formatExact(data.cacheWrite)} hint="tokens" />
          </div>

          <div className="flex flex-col gap-2">
            <Typography variant="h2" component="h2">
              Agents
            </Typography>
            <Paper>
              <TableContainer>
                <Table size="small" aria-label="Agents">
                  <TableHead>
                    <TableRow>
                      <TableCell>Agent</TableCell>
                      <TableCell className="hidden sm:table-cell">Model</TableCell>
                      <TableCell align="right">
                        <HeadLabel short="Req." long="Requests" />
                      </TableCell>
                      <TableCell align="right" className="hidden md:table-cell">
                        Tools
                      </TableCell>
                      <TableCell align="right">
                        <HeadLabel short="In" long="New in" />
                      </TableCell>
                      <TableCell align="right">Out</TableCell>
                      <TableCell align="right" className="hidden md:table-cell">
                        Cache read
                      </TableCell>
                      <TableCell align="right" className="hidden md:table-cell">
                        Cache write
                      </TableCell>
                      <TableCell align="right">
                        <HeadLabel short="Est. $" long="Est. cost" />
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {agents.map((a) => (
                      <TableRow key={a.agent}>
                        <TableCell className="max-w-[6.5rem] sm:max-w-[14rem]">
                          <div className="line-clamp-2 font-medium break-words sm:line-clamp-1" title={a.label || a.agent}>
                            {a.agent === 'main' ? 'Main thread' : a.label || a.agent}
                          </div>
                          {a.agent !== 'main' && a.label && (
                            <div className="truncate font-mono text-xs text-fg-muted" title={a.agent}>
                              {a.agent}
                            </div>
                          )}
                          <div className="truncate text-xs text-fg-muted sm:hidden">{a.model || '—'}</div>
                        </TableCell>
                        <TableCell className="hidden font-mono text-[0.8125rem] sm:table-cell">{a.model || '—'}</TableCell>
                        <TableCell align="right" title={formatExact(a.requests)}>
                          {formatCompact(a.requests)}
                        </TableCell>
                        <TableCell align="right" className="hidden md:table-cell" title={formatExact(a.tools)}>
                          {formatCompact(a.tools)}
                        </TableCell>
                        <TableCell align="right" title={formatExact(a.input)}>
                          {formatCompact(a.input)}
                        </TableCell>
                        <TableCell align="right" title={formatExact(a.output)}>
                          {formatCompact(a.output)}
                        </TableCell>
                        <TableCell align="right" className="hidden md:table-cell" title={formatExact(a.cacheRead)}>
                          {formatCompact(a.cacheRead)}
                        </TableCell>
                        <TableCell align="right" className="hidden md:table-cell" title={formatExact(a.cacheWrite)}>
                          {formatCompact(a.cacheWrite)}
                        </TableCell>
                        <TableCell align="right" className="font-medium whitespace-nowrap">
                          {formatUsd(a.costUsd)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Paper>
          </div>

          <Timeline id={id} />

          <div className="flex flex-col gap-2">
            <Typography variant="h2" component="h2">
              Tool calls
            </Typography>
            {tools.length === 0 ? (
              <Typography color="textSecondary">No tool calls in this session.</Typography>
            ) : (
              <Paper>
                <ul aria-label="Tool calls" className="m-0 list-none p-0">
                  {tools.map((t) => (
                    <li
                      key={t.tool}
                      className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-3 border-b border-line px-4 py-2 last:border-b-0 sm:grid-cols-[minmax(0,16rem)_1fr_4rem]"
                    >
                      <span className="truncate font-mono text-[0.8125rem]" title={t.tool}>
                        {t.tool}
                      </span>
                      <span aria-hidden className="h-2 overflow-hidden rounded-sm bg-panel-2">
                        <span
                          className="block h-full rounded-sm bg-accent-fill"
                          style={{ width: `${Math.max((t.count / maxCount) * 100, 1)}%` }}
                        />
                      </span>
                      <span className="text-right text-sm font-medium tabular-nums" title={formatExact(t.count)}>
                        {formatCompact(t.count)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Paper>
            )}
          </div>
        </>
      )}
    </section>
  );
}
