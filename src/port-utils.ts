import { createServer } from 'node:net';

const DEFAULT_PORT = 3847;
const MAX_PORT_ATTEMPTS = 100;

/**
 * Check if a port is available by attempting to bind to it.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port, starting from the desired port. If it's taken, tries
 * the next ports up to maxAttempts. Updates process.env.PORT and returns the
 * port. Call this before app.listen() so the rest of the app sees the correct port.
 */
export async function ensurePortAvailable(
  desiredPort: number = DEFAULT_PORT,
  maxAttempts: number = MAX_PORT_ATTEMPTS,
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = desiredPort + i;
    if (await isPortAvailable(port)) {
      if (port !== desiredPort) {
        process.env.PORT = String(port);
        console.warn(`Port ${desiredPort} in use, using ${port} instead.`);
      }
      return port;
    }
  }
  throw new Error(`Could not find available port in range ${desiredPort}–${desiredPort + maxAttempts - 1}`);
}
