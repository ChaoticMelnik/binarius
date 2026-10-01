import { closeAll } from '@binarius/shared';
import { buildWebApp } from './app';
import { createBackendClient } from './backend-client';
import { parseEnv } from './env';
import { SHUTDOWN_BUDGET_MS } from './timing';

const env = parseEnv(process.env);

const app = buildWebApp({
  backend: createBackendClient({ baseUrl: env.backendUrl, token: env.adminWebToken }),
  publicOrigin: env.publicOrigin,
  brokerAuthorizeUrl: env.brokerAuthorizeUrl,
  secureCookies: env.secureCookies,
  logLevel: env.logLevel,
});

let shuttingDown = false;

// One phase: this process holds no database connection and no queue, so the only thing to
// drain is the request in flight, and the longest thing that waits on is one backend call.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const drained = await closeAll([() => app.close()], SHUTDOWN_BUDGET_MS);
  if (!drained) app.log.error('shutdown: a request did not finish within the budget');
  process.exit(drained ? 0 : 1);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));

await app.listen({ port: env.port, host: '0.0.0.0' });
