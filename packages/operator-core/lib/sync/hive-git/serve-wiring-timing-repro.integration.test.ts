import { describe, it, expect } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { _resetForTests } from '@papercusp/db-org';
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { setHiveGitMode } from '../../harness/git-sync/hive-git-mode';
import { wireHiveGitServe, openHiveGitFetchDuplex } from './serve-wiring';

describe('timing repro', () => {
  it('raw byte trace', async () => {
    const db = await createOrgTestDb();
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    _resetUrlCacheForTests();
    await _resetForTests();
    const WORKSPACE_ID = `ws-${randomUUID().slice(0, 8)}`;
    const HIVE = `hive-${randomUUID().slice(0, 8)}`;
    await insertHiveIfAbsent({ workspaceId: WORKSPACE_ID, homeSlug: HIVE, pubkeyBase64: Buffer.alloc(32, 9).toString('base64'), keychainId: 'k' });
    await setHiveGitMode(WORKSPACE_ID, HIVE, 'legacy');

    const sockPath = join(tmpdir(), `tr-${randomUUID().slice(0, 8)}.sock`);
    const TOPIC = Buffer.alloc(32, 7);
    let server: Server;
    let srvConnRef: Socket;
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConnRef = srvConn;
      srvConn.on('error', () => {});
      srvConn.on('data', (c) => console.log('[RAW] server received', c.length, 'bytes:', c.toString('hex')));
      wireHiveGitServe(srvConn, TOPIC, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    const clientSocket: Socket = await new Promise((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    clientSocket.on('error', () => {});
    clientSocket.on('data', (c) => console.log('[RAW] client received', c.length, 'bytes:', c.toString('hex')));
    await new Promise((r) => setTimeout(r, 800));
    const duplex = await openHiveGitFetchDuplex(clientSocket, TOPIC, { repoKey: 'whatever' });
    const result = await new Promise<string>((resolve) => {
      duplex.on('error', (e) => resolve('error:' + e.message));
      duplex.on('close', () => resolve('closed-no-error'));
      setTimeout(() => resolve('TIMED OUT'), 5_000);
    });
    console.log('OUTCOME:', result);
    server.close();
    await db.cleanup();
  }, 20000);
});
