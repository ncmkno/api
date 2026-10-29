import { checkSocketDirectory, ConfigError, dailyBudget, dbPath, socketPath, tcpPort } from './config.ts';
import { openDb } from './db.ts';
import { startListeners } from './listeners.ts';

async function main(): Promise<void> {
  const socket = socketPath();
  checkSocketDirectory(socket); // a bad setting stops the start here, before the database or the socket is touched
  const port = tcpPort();
  dailyBudget(); // a bad budget stops the start too, rather than failing on the first settings read
  const db = openDb(dbPath());
  const listeners = await startListeners(db, { socket, port });
  console.log(`usage-monitor listening on ${socket}${listeners.tcpPort === null ? '' : ` and http://127.0.0.1:${listeners.tcpPort}`}`);

  const shutdown = (): void => {
    void listeners.close().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `usage-monitor: ${error.message}` : error);
  process.exit(1);
});
