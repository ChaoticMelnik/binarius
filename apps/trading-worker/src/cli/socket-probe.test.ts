import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { runSocketProbeCli } from './socket-probe';

// The one door against a database the CLI cannot reach (#150): one line and exit 1, no throw, and
// neither the backend nor the broker asked for anything.
describe('socket-probe against an unreachable database', () => {
  it('answers setup failed with the error name and code', async () => {
    let backendCalls = 0;
    const backend = createServer((_request, response) => {
      backendCalls += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    const { port } = backend.address() as AddressInfo;
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runSocketProbeCli(
        {
          ACCOUNT_ID: '3f0c2a52-58b4-4e6a-9d0e-6a1b2c3d4e5f',
          BROKER_WS_URL: 'wss://broker-ws.example.test',
          BACKEND_URL: `http://127.0.0.1:${port}`,
          INTERNAL_API_TOKEN: 'internal-token-for-tests-0123456789',
          DATABASE_URL: 'postgres://binarius:secret@127.0.0.1:1/binarius',
          BROKER_API_BASE_URL: 'https://broker-api.example.test',
        },
        (line) => out.push(line),
        (line) => err.push(line),
      );

      expect([code, out, err]).toEqual([1, [], ['setup failed: Error (Error ECONNREFUSED)']]);
      expect(backendCalls).toBe(0);
    } finally {
      await new Promise((resolve) => backend.close(resolve));
    }
  });
});
