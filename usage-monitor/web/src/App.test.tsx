import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { formatUsd } from './format';
import { renderWithTheme, stubApi } from './test/utils';
import { sessionDetail, sessions, summary } from './test/fixtures';

vi.mock('@mui/x-charts/BarChart', () => ({ BarChart: () => <div data-testid="bar-chart" /> }));

const answer = (url: string) => {
  if (url.startsWith('/api/summary')) return { body: summary };
  if (url.startsWith('/api/sessions/')) return { body: sessionDetail };
  return { body: sessions };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App', () => {
  it('starts on the sessions list and links the two top-level views', async () => {
    stubApi(answer);
    renderWithTheme(<App />);
    expect(await screen.findByRole('table', { name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sessions', selected: true })).toHaveAttribute('href', '#/');
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('href', '#/summary');
  });

  it('names the view switcher once and marks the current view', async () => {
    stubApi(answer);
    renderWithTheme(<App />);
    await screen.findByRole('table', { name: 'Sessions' });
    expect(screen.getAllByLabelText('Views')).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Views' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'Summary' })).not.toHaveAttribute('aria-current');

    act(() => {
      window.location.hash = '#/summary';
    });
    await screen.findByRole('heading', { name: 'Summary' });
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('tab', { name: 'Sessions' })).not.toHaveAttribute('aria-current');
  });

  it('routes by hash between the three views without reloading', async () => {
    stubApi(answer);
    renderWithTheme(<App />);
    await screen.findByRole('table', { name: 'Sessions' });

    act(() => {
      window.location.hash = '#/summary';
    });
    expect(await screen.findByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Summary', selected: true })).toBeInTheDocument();

    act(() => {
      window.location.hash = '#/sessions/sess-newest';
    });
    expect(await screen.findByRole('table', { name: 'Agents' })).toBeInTheDocument();
    // A session is still under the "Sessions" tab.
    expect(screen.getByRole('tab', { name: 'Sessions', selected: true })).toBeInTheDocument();

    act(() => {
      window.location.hash = '#/';
    });
    expect(await screen.findByRole('table', { name: 'Sessions' })).toBeInTheDocument();
  });

  it('scrolls to the top on navigation and does not break when scrollTo returns a Promise', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubApi(answer);
    const { unmount } = renderWithTheme(<App />);
    await screen.findByRole('table', { name: 'Sessions' });
    const scrollTo = vi.mocked(window.scrollTo);
    scrollTo.mockClear();

    act(() => {
      window.location.hash = '#/summary';
    });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 0));
    unmount();
    expect(errors).not.toHaveBeenCalled();
  });

  it("puts today's estimated cost in the tab title", async () => {
    stubApi(answer);
    renderWithTheme(<App />);
    const cost = summary.byDay.reduce((n, d) => n + (d.costUsd ?? 0), 0);
    await waitFor(() => expect(document.title).toBe(`${formatUsd(cost)} today · Usage Monitor`));
  });
});

