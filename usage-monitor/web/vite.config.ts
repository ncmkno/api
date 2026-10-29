import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

// Dev only: the API listens on a Unix socket, so /api is proxied to it.
const runtimeDir = process.env.XDG_RUNTIME_DIR;
const socketPath =
  process.env.USAGE_MONITOR_SOCKET ?? (runtimeDir ? join(runtimeDir, 'usage-monitor.sock') : undefined);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs; the hashed files go to dist/assets/, which the API serves as immutable.
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 1000 },
  server: {
    proxy: socketPath ? { '/api': { target: { socketPath, host: 'localhost', port: 80 } } } : undefined,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Days follow the local time zone; pin it so the tests mean the same everywhere.
    env: { TZ: 'UTC' },
    // Node 25 warns about --localstorage-file whenever jsdom's globals touch its own localStorage.
    execArgv: ['--no-experimental-webstorage'],
  },
});
