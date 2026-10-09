/**
 * WI-10006543: one `graph:query` callers question, answered in its own process.
 *
 * Forked by first-party-callers-offthread.ts, one process per question. The
 * scoped TypeScript program takes seconds and 0.7-1.5 GB, so it runs here rather
 * than on the operator's event loop, and the memory goes back to the OS when the
 * process exits. A bundled host loads the esbuilt `first-party-callers.worker.mjs`
 * (bundle-host-common.sh); an unbundled host forks this file under Node's native
 * type stripping, which is why its import graph uses explicit `.ts` extensions.
 *
 * TypeScript itself is never bundled: it is loaded from the vendored LSP install
 * the host names, the same TypeScript typescript-language-server runs.
 */
import { failedCallersAnswer, firstPartyCallers, type FirstPartyCallersAnswer } from './first-party-callers.ts';
import { loadVendoredTypescript } from './typescript-service.ts';

export interface FirstPartyCallersJob {
  readonly vendorDir: string;
  readonly root: string;
  readonly repositoryId?: string;
  readonly name: string;
  readonly limit?: number;
  /** Repository-relative search roots; absent = the whole repository. */
  readonly paths?: readonly string[];
  readonly rgPath?: string;
}

if (!process.send) throw new Error('first-party-callers.worker must be forked with an IPC channel');

const job = await new Promise<FirstPartyCallersJob>((resolve) => process.once('message', resolve));
const started = Date.now();
let result: FirstPartyCallersAnswer;
try {
  const ts = loadVendoredTypescript(job.vendorDir);
  result = firstPartyCallers({ ts, root: job.root, repositoryId: job.repositoryId, name: job.name, limit: job.limit, paths: job.paths, rgPath: job.rgPath });
} catch (error) {
  // Loading TypeScript is the one step firstPartyCallers does not guard itself.
  const why = error instanceof Error ? error.message : String(error);
  result = failedCallersAnswer(job.name, `could not load the vendored TypeScript from ${job.vendorDir}: ${why}`, started);
}
await new Promise<void>((resolve, reject) => process.send!(result, (error: Error | null) => (error ? reject(error) : resolve())));
process.disconnect();
