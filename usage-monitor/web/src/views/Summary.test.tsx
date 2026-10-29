import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { calledUrls, renderWithTheme, stubApi } from '../test/utils';
import { summary } from '../test/fixtures';
import { rangeBounds, Summary } from './Summary';

// Charts need real layout (ResizeObserver, sizes); here they only report what they were given.
vi.mock('@mui/x-charts/BarChart', () => ({
  BarChart: (props: { series: { label: string; data: number[] }[]; xAxis: { data: string[] }[] }) => (
    <div
      data-testid="bar-chart"
      data-days={props.xAxis[0]!.data.join(',')}
      data-series={props.series.map((s) => `${s.label}:${s.data.join('|')}`).join(';')}
    />
  ),
}));

const NOW = Date.UTC(2026, 9, 28, 17, 44); // Wed Oct 28 2026, 17:44 UTC

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

const statCard = (label: string) => screen.getByText(label, { selector: '.MuiTypography-overline' }).parentElement!;

describe('rangeBounds', () => {
  it('maps 7 and 30 days to the start of a local day up to now, and "all" to nothing', () => {
    expect(rangeBounds('7d', NOW)).toEqual({ from: Date.UTC(2026, 9, 22), to: NOW });
    expect(rangeBounds('30d', NOW)).toEqual({ from: Date.UTC(2026, 8, 29), to: NOW });
    expect(rangeBounds('all', NOW)).toEqual({});
  });

  it('starts at local midnight in the given offset, in minutes east of UTC', () => {
    // 17:44 UTC is 01:44 on Oct 29 at UTC+8, so 7 days start at Oct 23 00:00 there
    expect(rangeBounds('7d', NOW, 480)).toEqual({ from: Date.UTC(2026, 9, 22, 16), to: NOW });
    expect(rangeBounds('7d', NOW, -300)).toEqual({ from: Date.UTC(2026, 9, 22, 5), to: NOW });
  });
});

describe('Summary', () => {
  it('shows the range selector with last 7 days selected, and requests that window', async () => {
    const fetchMock = stubApi(() => ({ body: summary }));
    renderWithTheme(<Summary />);

    const group = screen.getByRole('group', { name: 'Time range' });
    expect(within(group).getByRole('button', { name: 'Last 7 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');

    await screen.findByRole('table', { name: 'Usage by model' });
    expect(calledUrls(fetchMock)[0]).toBe(`/api/summary?from=${Date.UTC(2026, 9, 22)}&to=${NOW}&tz=0`);
  });

  it('switches range: 30 days and all map to from/to, with skeletons rather than stale data', async () => {
    const fetchMock = stubApi(() => ({ body: summary }));
    renderWithTheme(<Summary />);
    await screen.findByRole('table', { name: 'Usage by model' });

    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await screen.findByRole('table', { name: 'Usage by model' });
    expect(calledUrls(fetchMock)).toContain(`/api/summary?from=${Date.UTC(2026, 8, 29)}&to=${NOW}&tz=0`);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await screen.findByRole('table', { name: 'Usage by model' });
    expect(calledUrls(fetchMock).at(-1)).toBe('/api/summary?tz=0'); // all time has no previous window
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows totals for the range as stat cards', async () => {
    stubApi(() => ({ body: summary }));
    renderWithTheme(<Summary />);
    await screen.findByRole('table', { name: 'Usage by model' });

    expect(statCard('Est. cost')).toHaveTextContent('$10.00');
    expect(statCard('Requests')).toHaveTextContent('300');
    expect(statCard('Tool calls')).toHaveTextContent('210');
    expect(statCard('New tokens')).toHaveTextContent('480k'); // 120k in + 360k out
    expect(statCard('New tokens')).toHaveTextContent('120k in · 360k out');
  });

  it('charts cost and tokens per day, filling days with no usage so the axis is continuous', async () => {
    stubApi(() => ({ body: summary }));
    renderWithTheme(<Summary />);
    const charts = await screen.findAllByTestId('bar-chart');
    expect(charts).toHaveLength(2);

    const days = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
    expect(charts[0]).toHaveAttribute('data-days', days.join(','));
    expect(charts[0]).toHaveAttribute('data-series', 'Est. cost:0|0|0|0|2.5|0|7.5');
    expect(charts[1]).toHaveAttribute(
      'data-series',
      'New in:0|0|0|0|40000|0|80000;Out:0|0|0|0|120000|0|240000;Cache write:0|0|0|0|300000|0|600000;Cache read:0|0|0|0|9000000|0|18000000',
    );
    expect(screen.getByRole('heading', { name: 'Cost per day' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tokens per day' })).toBeInTheDocument();
  });

  it('compares each total with the previous window of the same length', async () => {
    const { from } = rangeBounds('7d', NOW);
    const previous = {
      byDay: [{ day: '2026-10-18', requests: 320, tools: 200, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 4 }],
      byModel: [],
    };
    const fetchMock = stubApi((url) => (url.includes(`to=${from! - 1}`) ? { body: previous } : { body: summary }));
    renderWithTheme(<Summary />);
    await waitFor(() => expect(statCard('Est. cost')).toHaveTextContent('+$6.00 vs previous 7 days'));
    expect(statCard('Requests')).toHaveTextContent('−20 vs previous 7 days');
    expect(statCard('Tool calls')).toHaveTextContent('+10 vs previous 7 days');
    expect(calledUrls(fetchMock)).toContain(`/api/summary?from=${from! - 7 * 86_400_000}&to=${from! - 1}&tz=0`);
  });

  it('says so when the previous window was empty, and shows a daily average for all time', async () => {
    const { from } = rangeBounds('7d', NOW);
    stubApi((url) => (url.includes(`to=${from! - 1}`) ? { body: { byDay: [], byModel: [] } } : { body: summary }));
    renderWithTheme(<Summary />);
    await waitFor(() => expect(statCard('Est. cost')).toHaveTextContent('Nothing in previous 7 days'));

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    // all time spans Oct 26 to Oct 28: 3 days, $10.00 in total
    await waitFor(() => expect(statCard('Est. cost')).toHaveTextContent('Avg $3.33 a day'));
  });

  it('shows a dash, not $0.00, for an est. cost when no day in the range had a price', async () => {
    const unpriced = {
      byDay: summary.byDay.map((d) => ({ ...d, costUsd: null })),
      byModel: [summary.byModel[2]!],
    };
    stubApi(() => ({ body: unpriced }));
    renderWithTheme(<Summary />);
    await screen.findByRole('table', { name: 'Usage by model' });
    expect(statCard('Est. cost')).toHaveTextContent('—');
    expect(statCard('Est. cost')).not.toHaveTextContent('$');
    expect(statCard('Requests')).toHaveTextContent('300');
  });

  it('adds up only the days that have a price', async () => {
    const mixed = { ...summary, byDay: [{ ...summary.byDay[0]!, costUsd: null }, summary.byDay[1]!] };
    stubApi(() => ({ body: mixed }));
    renderWithTheme(<Summary />);
    await screen.findByRole('table', { name: 'Usage by model' });
    expect(statCard('Est. cost')).toHaveTextContent('$7.50');
  });

  it('gives the charts a text alternative: a name on each and a table of the per-day values', async () => {
    stubApi(() => ({ body: { ...summary, byDay: [{ ...summary.byDay[0]!, costUsd: null }, summary.byDay[1]!] } }));
    renderWithTheme(<Summary />);
    await screen.findAllByTestId('bar-chart');

    for (const title of ['Cost per day', 'Tokens per day']) {
      expect(screen.getByRole('img', { name: new RegExp(`^${title}, bar chart.*Usage per day`) })).toBeInTheDocument();
    }
    const table = screen.getByRole('table', { name: 'Usage per day' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Day',
      'Est. cost',
      'New in',
      'Out',
      'Cache write',
      'Cache read',
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(7); // the 7 days of the range, empty ones included
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(within(rows[0]!).getByRole('rowheader')).toHaveTextContent('Oct 22');
    expect(cells(rows[0]!)).toEqual(['$0.00', '0', '0', '0', '0']);
    expect(within(rows[4]!).getByRole('rowheader')).toHaveTextContent('Oct 26');
    expect(cells(rows[4]!)).toEqual(['—', '40,000', '120,000', '300,000', '9,000,000']); // unpriced day
    expect(cells(rows[6]!)).toEqual(['$7.50', '80,000', '240,000', '600,000', '18,000,000']);
  });

  it('lists models by cost with a share of total, unpriced models last', async () => {
    stubApi(() => ({ body: summary }));
    renderWithTheme(<Summary />);
    const table = await screen.findByRole('table', { name: 'Usage by model' });

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      'claude-opus-4-7',
      'claude-haiku-4-5',
      'claude-unpriced',
    ]);
    expect(rows[0]).toHaveTextContent('$8.00');
    expect(rows[0]).toHaveTextContent('80%');
    expect(rows[1]).toHaveTextContent('10%');
    expect(rows[2]).toHaveTextContent('—');
    expect(rows[2]).toHaveTextContent('0%');
  });

  it('shows the empty state for "all" with nothing recorded', async () => {
    stubApi(() => ({ body: { byDay: [], byModel: [] } }));
    renderWithTheme(<Summary />);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    const empty = await screen.findByRole('status');
    expect(empty).toHaveTextContent(
      'No usage recorded yet. Set apiSocket in the usage-monitor mod to start reporting.',
    );
    expect(screen.queryByTestId('bar-chart')).not.toBeInTheDocument();
  });

  it('explains an empty window and suggests a longer range', async () => {
    stubApi(() => ({ body: { byDay: [], byModel: [] } }));
    renderWithTheme(<Summary />);
    const empty = await screen.findByRole('status');
    expect(empty).toHaveTextContent('No usage in this range');
    expect(empty).toHaveTextContent('last 7 days');
    // The range selector stays usable.
    expect(screen.getByRole('button', { name: 'All' })).toBeEnabled();
  });

  it('shows the error state, keeps the selector, and recovers after retry', async () => {
    let up = false;
    stubApi(() => (up ? { body: summary } : 'network-error'));
    renderWithTheme(<Summary />);

    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the usage API");
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeInTheDocument();

    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('table', { name: 'Usage by model' });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('draws the daily budget on the cost chart and says so in its note', async () => {
    stubApi((url) => (url === '/api/settings' ? { body: { dailyBudgetUsd: 20 } } : { body: summary }));
    renderWithTheme(<Summary />);
    await waitFor(() => expect(screen.getByText('Estimated (est.), USD, local days; dashed line: $20.00 daily budget')).toBeInTheDocument());
  });
});

