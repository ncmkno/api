import IconButton from '@mui/material/IconButton';
import SvgIcon from '@mui/material/SvgIcon';
import { useColorScheme } from '@mui/material/styles';

// Feather's moon and sun (24x24, stroked), so no icon package is needed.
const MOON = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';
const SUN =
  'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42';

// Dark is the default; MUI keeps a switched choice in localStorage.
export function ThemeToggle() {
  const { mode, setMode } = useColorScheme();
  const isDark = mode !== 'light';

  return (
    <IconButton
      size="small"
      sx={{ '@media (pointer: coarse)': { minWidth: 44, minHeight: 44 } }}
      onClick={() => setMode(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <SvgIcon
        fontSize="small"
        sx={{ fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}
      >
        <path d={isDark ? SUN : MOON} />
      </SvgIcon>
    </IconButton>
  );
}
