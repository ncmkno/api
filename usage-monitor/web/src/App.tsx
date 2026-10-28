import { useEffect } from 'react';
import { fetchSummary } from './api';
import AppBar from '@mui/material/AppBar';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { ThemeToggle } from './components/ThemeToggle';
import { formatUsd } from './format';
import { hrefs, useRoute } from './route';
import { usePolling } from './usePolling';
import { SessionDetail } from './views/SessionDetail';
import { Sessions } from './views/Sessions';
import { Summary } from './views/Summary';
import { Widget } from './views/Widget';

/** Local midnight, so "today" in the tab title is the user's day. */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today's estimated cost in the tab title, readable from any tab. */
function useCostTitle() {
  const from = startOfToday();
  const { data } = usePolling(`title:${from}`, (signal) => fetchSummary({ from }, signal));
  const priced = (data?.byDay ?? []).filter((d) => d.costUsd !== null);
  const cost = priced.length > 0 ? priced.reduce((n, d) => n + (d.costUsd ?? 0), 0) : null;
  useEffect(() => {
    document.title = data ? `${formatUsd(cost)} today · Usage Monitor` : 'Usage Monitor';
  }, [data, cost]);
}

export function App() {
  const route = useRoute();
  useCostTitle();
  const tab = route.name === 'summary' ? 'summary' : 'sessions'; // a session is under "Sessions"
  const current = (value: typeof tab) => (value === tab ? { 'aria-current': 'page' as const } : {});
  const routeKey = route.name === 'session' ? `session:${route.id}` : route.name;

  // A hash change does not reset scroll the way a page load does.
  // (Braces matter: current browsers return a Promise from scrollTo, which an effect must not return.)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [routeKey]);

  // The desktop app's floating window: the card alone, no app bar.
  if (route.name === 'widget') return <Widget />;

  return (
    <>
      <AppBar
        position="sticky"
        color="inherit"
        elevation={0}
        sx={{ bgcolor: 'background.default', borderBottom: 1, borderColor: 'divider', boxShadow: 'none' }}
      >
        <Toolbar className="mx-auto w-full max-w-[96rem] gap-2 px-3 sm:gap-4 sm:px-6" disableGutters variant="dense">
          {/* Below 380 px the tabs and the theme toggle need the room; the name stays for screen readers. */}
          <Typography
            component="span"
            className="whitespace-nowrap max-[379px]:sr-only"
            sx={{ fontWeight: 500, letterSpacing: '-0.01em', fontSize: '1rem' }}
          >
            Usage Monitor
          </Typography>
          <nav aria-label="Views" className="ml-auto">
            <Tabs value={tab}>
              <Tab label="Sessions" value="sessions" component="a" href={hrefs.sessions} {...current('sessions')} />
              <Tab label="Summary" value="summary" component="a" href={hrefs.summary} {...current('summary')} />
            </Tabs>
          </nav>
          <ThemeToggle />
        </Toolbar>
      </AppBar>
      <main className="mx-auto w-full max-w-[96rem] px-3 py-6 sm:px-6 sm:py-8">
        {route.name === 'sessions' && <Sessions />}
        {route.name === 'session' && <SessionDetail key={route.id} id={route.id} />}
        {route.name === 'summary' && <Summary />}
      </main>
    </>
  );
}
