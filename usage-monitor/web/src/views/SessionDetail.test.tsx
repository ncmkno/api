import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { calledUrls, renderWithTheme, stubApi } from '../test/utils';
import { sessionDetail } from '../test/fixtures';
import { SessionDetail } from './SessionDetail';

const statCard = (label: string) => screen.getByText(label, { selector: '.MuiTypography-overline' }).parentElement!;

describe('SessionDetail', () => {
  it('fetches the session by id and shows skeletons first', async () => {
    const fetchMock = stubApi(() => ({ body: sessionDetail }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await screen.findByRole('table', { name: 'Agents' });
    expect(calledUrls(fetchMock)[0]).toBe('/api/sessions/sess-newest');
  });

  it('shows the totals as stat cards, with the tool-call total summed from the list', async () => {
    stubApi(() => ({ body: sessionDetail }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    await screen.findByRole('table', { name: 'Agents' });

    expect(statCard('Est. cost')).toHaveTextContent('$48.20');
    expect(statCard('Requests')).toHaveTextContent('1.8k');
    expect(statCard('Tool calls')).toHaveTextContent('152'); // 50 + 100 + 2
    expect(statCard('New in')).toHaveTextContent('570k');
    expect(statCard('Out')).toHaveTextContent('1.7M');
    expect(statCard('Cache read')).toHaveTextContent('167M');
    expect(statCard('Cache write')).toHaveTextContent('5.3M');
  });

  it('shows the directory, times and session id, with a back link', async () => {
    stubApi(() => ({ body: sessionDetail }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    await screen.findByRole('table', { name: 'Agents' });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('…/api/usage-monitor');
    expect(screen.getByText(/Started Oct 28, 16:44/)).toHaveTextContent('last activity Oct 28, 17:44');
    expect(screen.getByText('sess-newest')).toBeInTheDocument(); // the full id, not the 8 characters of the list
    expect(screen.getByRole('link', { name: /All sessions/ })).toHaveAttribute('href', '#/');
  });

  it('lists agents by cost, highest first, unpriced last, with labels and models', async () => {
    stubApi(() => ({ body: sessionDetail }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    const table = await screen.findByRole('table', { name: 'Agents' });

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Main thread');
    expect(rows[0]).toHaveTextContent('claude-opus-4-7');
    expect(rows[0]).toHaveTextContent('$27.96');
    expect(rows[1]).toHaveTextContent('review-backend');
    expect(rows[1]).toHaveTextContent('agent-cheap'); // the id stays visible beside a label
    expect(rows[1]).toHaveTextContent('$4.34');
    expect(rows[2]).toHaveTextContent('Explore: find usages');
    expect(rows[2]).toHaveTextContent('—');
  });

  it('shows a dash for an agent with no model, label or price, and the total of a wholly unpriced session', async () => {
    const bare = { ...sessionDetail.agents[2]!, agent: 'agent-bare', label: '', model: '', costUsd: null };
    stubApi(() => ({ body: { ...sessionDetail, costUsd: null, agents: [bare] } }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    const table = await screen.findByRole('table', { name: 'Agents' });

    const [row] = within(table).getAllByRole('row').slice(1) as [HTMLElement];
    expect(row).toHaveTextContent('agent-bare'); // no label: the id is the name
    expect(within(row).getAllByText('—')).toHaveLength(3); // phone sub-line, Model cell, Est. cost
    expect(within(row).getAllByRole('cell')[1]).toHaveTextContent(/^—$/);
    expect(statCard('Est. cost')).toHaveTextContent('—');
    expect(statCard('Est. cost')).not.toHaveTextContent('$');
  });

  it('draws tool-call bars in proportion to the busiest tool, busiest first', async () => {
    stubApi(() => ({ body: sessionDetail }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    const list = await screen.findByRole('list', { name: 'Tool calls' });

    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('span')!.textContent)).toEqual([
      'Bash',
      'Read',
      'mcp__playwright__browser_navigate',
    ]);
    const widths = items.map((li) => (li.querySelector('[style]') as HTMLElement).style.width);
    expect(widths).toEqual(['100%', '50%', '2%']);
    expect(items[0]).toHaveTextContent('100');
  });

  it('says so when a session has no tool calls', async () => {
    stubApi(() => ({ body: { ...sessionDetail, tools: [] } }));
    renderWithTheme(<SessionDetail id="sess-newest" />);
    await screen.findByRole('table', { name: 'Agents' });
    expect(screen.getByText('No tool calls in this session.')).toBeInTheDocument();
    expect(statCard('Tool calls')).toHaveTextContent('0');
  });

  it('shows "Session not found" with a way back for an unknown id', async () => {
    stubApi(() => ({ status: 404, body: { error: 'unknown session' } }));
    renderWithTheme(<SessionDetail id="gone" />);
    expect(await screen.findByText('Session not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All sessions/ })).toHaveAttribute('href', '#/');
    expect(screen.queryByRole('alert', { name: /reach/ })).not.toBeInTheDocument();
  });

  it('shows the error state when the API is unreachable and retry recovers', async () => {
    let up = false;
    stubApi(() => (up ? { body: sessionDetail } : 'network-error'));
    renderWithTheme(<SessionDetail id="sess-newest" />);

    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach the usage API");
    expect(screen.getByRole('link', { name: /All sessions/ })).toBeInTheDocument();

    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('table', { name: 'Agents' });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('shows the session\'s tool calls as a timeline, folding repeats into one row with a count', async () => {
    const call = (ts: number, tool: string, detail: string | null) => ({
      ts, tool, detail, session: 'sess-newest', agent: 'main', label: '', cwd: '/w',
    });
    const fetchMock = stubApi((url) =>
      url.startsWith('/api/tools')
        ? { body: { byTool: [], calls: [call(3, 'Read', 'a.ts'), call(2, 'Read', 'a.ts'), call(1, 'Read', 'a.ts'), call(0, 'Bash', 'ls')] } }
        : { body: sessionDetail },
    );
    renderWithTheme(<SessionDetail id="sess-newest" />);
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(2));
    const [first, second] = within(timeline).getAllByRole('listitem') as [HTMLElement, HTMLElement];
    expect(first).toHaveTextContent('a.ts');
    expect(within(first).getByLabelText('Repeated 3 times')).toHaveTextContent('×3');
    expect(second).toHaveTextContent('ls');
    expect(calledUrls(fetchMock)).toContain('/api/tools?session=sess-newest&limit=200');
  });

  it('shows the agent column of the timeline only when more than one agent made calls, and marks calls with no summary', async () => {
    const call = (ts: number, agent: string, detail: string | null) => ({
      ts, tool: 'Bash', detail, session: 'sess-newest', agent, label: '', cwd: '/w',
    });
    stubApi((url) =>
      url.startsWith('/api/tools') ? { body: { byTool: [], calls: [call(2, 'main', 'ls'), call(1, 'main', null)] } } : { body: sessionDetail },
    );
    renderWithTheme(<SessionDetail id="sess-newest" />);
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => expect(within(timeline).getAllByRole('listitem')).toHaveLength(2));
    expect(within(timeline).queryByText('main')).not.toBeInTheDocument();
    expect(within(timeline).getByTitle('Recorded before tool summaries were sent')).toBeInTheDocument();
  });
});

