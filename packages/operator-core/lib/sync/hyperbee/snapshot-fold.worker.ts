/**
 * WI-10002855 — the snapshot-fold worker thread. A thin shell: every decision lives in
 * `createSnapshotFoldHandler` (snapshot-fold-protocol.ts), which is tested directly.
 *
 * Bundled to `snapshot-fold.worker.mjs` beside the host entry by BOTH bundlers
 * (apps/operator/bin/bundle-host.sh, papercusp-desktop/bin/build-desktop-sidecar.sh);
 * `worker-scripts-bundled.test.ts` fails if either stops doing so. Under tsx the `.ts`
 * form runs directly (see `snapshotFoldWorkerPath`).
 */
import { parentPort } from 'node:worker_threads';
import { createSnapshotFoldHandler, type SnapshotFoldRequest } from './snapshot-fold-protocol';

if (!parentPort) throw new Error('snapshot-fold.worker must run as a worker thread');
const port = parentPort;
const handle = createSnapshotFoldHandler();
port.on('message', (req: SnapshotFoldRequest) => {
  const { res, transfer } = handle(req);
  port.postMessage(res, transfer);
});
