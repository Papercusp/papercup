/**
 * embedded-pg-host-credentials.integration.test.ts — WI-10003627, real postmaster.
 *
 * MEASURED on a hosted workspace VM (2026-09-28): the customer account logged in
 * to the operator's embedded Postgres on 127.0.0.1 as harness_admin (rolsuper)
 * with its repo-public default password. Loopback TCP is not a uid boundary, so on
 * a multi-account host the ONLY boundary is the password. This suite boots a real
 * embedded cluster with `credentialsFile` and proves, by actually logging in:
 *
 *   1. fresh boot  — every role refuses its repo-public default; the returned URLs
 *                    (the per-host secrets) work.
 *   2. upgrade     — a cluster first keyed to the defaults (every hosted VM booted
 *                    before this fix) is re-keyed on the next boot, and the
 *                    defaults stop authenticating.
 *   3. integrity   — a privileged role planted while the defaults were live makes
 *                    the next boot REFUSE and leaves no reachable postmaster.
 *
 * No migrations are applied (dbSqlDir unset): the rail under test is the role and
 * authentication layer, which is identical with or without the schema.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createServer, Socket } from 'node:net';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import {
  DEFAULT_ROLE_PASSWORDS,
  ROLE_NAMES,
  startEmbeddedPostgresServer,
} from '@papercusp/embedded-postgres-server';

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(path);
  return path;
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('free-port probe returned no TCP address'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

type Slot = keyof typeof ROLE_NAMES;
const SLOTS: Slot[] = ['owner', 'admin', 'app', 'zero'];

/** Log in for real; resolve to 'accepted' or the refusing SQLSTATE. */
async function tryLogin(port: number, user: string, secret: string): Promise<string> {
  const client = postgres({
    host: 'localhost',
    port,
    user,
    password: secret,
    database: 'postgres',
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    await client`SELECT 1`;
    return 'accepted';
  } catch (e) {
    return String((e as { code?: string }).code ?? (e as Error).message);
  } finally {
    await client.end({ timeout: 2 }).catch(() => {});
  }
}

async function portAccepting(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

describe('embedded PG on a multi-account host keys every role to per-host secrets', () => {
  it('fresh boot: every repo-public default is refused and the returned URLs authenticate', async () => {
    const work = await tempDir('epg-host-fresh-');
    const port = await freePort();
    const credentialsFile = join(work, 'state', 'embedded-pg-credentials.json');
    const pg = await startEmbeddedPostgresServer({ port, dataDir: join(work, 'pgdata'), credentialsFile });
    try {
      expect(pg.hostCredentials).toBe(true);
      for (const slot of SLOTS) {
        expect(await tryLogin(port, ROLE_NAMES[slot], DEFAULT_ROLE_PASSWORDS[slot])).toBe('28P01');
      }
      for (const url of [pg.urls.admin, pg.urls.app]) {
        const client = postgres(url, { max: 1, onnotice: () => {} });
        try {
          const [row] = await client`SELECT current_user AS who`;
          expect(['harness_admin', 'harness_app']).toContain(row.who);
        } finally {
          await client.end({ timeout: 2 });
        }
      }
      expect(pg.urls.admin).not.toContain(DEFAULT_ROLE_PASSWORDS.admin);
    } finally {
      await pg.stop();
    }
  }, 120_000);

  it('upgrade: a cluster first keyed to the defaults is re-keyed on the next boot', async () => {
    const work = await tempDir('epg-host-upgrade-');
    const port = await freePort();
    const dataDir = join(work, 'pgdata');

    // Boot 1 — the pre-fix hosted VM: no credentials file, defaults live.
    const legacy = await startEmbeddedPostgresServer({ port, dataDir });
    try {
      expect(legacy.hostCredentials).toBe(false);
      expect(await tryLogin(port, ROLE_NAMES.admin, DEFAULT_ROLE_PASSWORDS.admin)).toBe('accepted');
    } finally {
      await legacy.stop();
    }

    // Boot 2 — the fixed release on the same data dir.
    const credentialsFile = join(work, 'embedded-pg-credentials.json');
    const fixed = await startEmbeddedPostgresServer({ port, dataDir, credentialsFile });
    try {
      for (const slot of SLOTS) {
        expect(await tryLogin(port, ROLE_NAMES[slot], DEFAULT_ROLE_PASSWORDS[slot])).toBe('28P01');
      }
      const admin = postgres(fixed.urls.admin, { max: 1, onnotice: () => {} });
      try {
        const [row] = await admin`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`;
        expect(row.rolsuper).toBe(true);
      } finally {
        await admin.end({ timeout: 2 });
      }
    } finally {
      await fixed.stop();
    }

    // Boot 3 — a plain restart re-uses the stored secrets (no lock-out).
    const again = await startEmbeddedPostgresServer({ port, dataDir, credentialsFile });
    try {
      expect(again.urls.admin).toBe(fixed.urls.admin);
    } finally {
      await again.stop();
    }
  }, 180_000);

  it('integrity: a privileged role planted while the defaults were live makes boot refuse', async () => {
    const work = await tempDir('epg-host-rogue-');
    const port = await freePort();
    const dataDir = join(work, 'pgdata');

    // The exposure window: a co-resident account logs in with the default and plants a role.
    const legacy = await startEmbeddedPostgresServer({ port, dataDir });
    const intruder = postgres(legacy.urls.admin, { max: 1, onnotice: () => {} });
    try {
      await intruder.unsafe('CREATE ROLE planted_by_customer LOGIN SUPERUSER');
    } finally {
      await intruder.end({ timeout: 2 });
      await legacy.stop();
    }

    await expect(
      startEmbeddedPostgresServer({
        port,
        dataDir,
        credentialsFile: join(work, 'embedded-pg-credentials.json'),
      }),
    ).rejects.toThrow(/integrity check failed: unexpected privileged role\(s\) planted_by_customer/);
    // A refused boot must not leave a reachable postmaster behind.
    expect(await portAccepting(port)).toBe(false);
  }, 180_000);
});
