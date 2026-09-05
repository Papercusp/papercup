import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { handler } from './host-handler';

const servers: Array<ReturnType<typeof serve>> = [];
const ENV_KEYS = [
  'PAPERCUSP_ALLOW_REMOTE_ADMIN',
  'PAPERCUSP_BIND_HOST',
  'PAPERCUSP_REMOTE_ORIGINS',
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function startServer() {
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req, bindings) => {
      // The real adapter supplies the accepted socket through the second
      // fetch argument. Override only its peer address so a loopback test
      // connection exercises the off-box branch deterministically.
      Object.defineProperty(bindings.incoming.socket, 'remoteAddress', {
        configurable: true,
        value: '203.0.113.10',
      });
      return handler(req, bindings);
    },
  });
  servers.push(server);
  return new Promise<typeof server>((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function getHealth(port: number): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'GET',
        path: '/api/health',
        headers: {
          host: 'localhost',
          origin: 'https://app.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'app.example.com',
          'x-papercusp-workspace': 'papercusp-workspace',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('host handler HTTP composition', () => {
  it('preserves socket context so forged loopback Host headers cannot bypass remote auth', async () => {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = '1';
    process.env.PAPERCUSP_BIND_HOST = '0.0.0.0';
    process.env.PAPERCUSP_REMOTE_ORIGINS = 'https://app.example.com';

    const server = await startServer();
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind TCP');
    }

    const response = await getHealth(address.port);
    process.stderr.write(`host-handler-http debug response ${JSON.stringify(response)}\n`);
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: 'unauthorized',
        message: 'a verified remote operator session is required',
      },
    });
  });
});
