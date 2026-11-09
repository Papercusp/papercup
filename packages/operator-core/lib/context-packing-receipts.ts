/** Packing evidence extends the existing immutable text-artifact store. It is
 * deliberately separate from emission cursors: a receipt exists even when the
 * context budget is zero, and never acknowledges delivery. */
import { createHash } from 'node:crypto';
import type { ContextPackingReceipt } from './context-doors';
import { activeWorkspaceId } from './workspace-registry';
import { compareAndSwapTextArtifact, loadImmutableTextArtifact, loadTextArtifact, saveImmutableTextArtifact } from './text-artifacts';

export interface ContextPackingScope {
  workspaceId: string;
  ownerId: string;
  harness: string;
  port: 'turn-start' | 'mid-turn';
  client: string;
}
export interface StoredContextPackingReceipt {
  scope: ContextPackingScope;
  receipt: ContextPackingReceipt;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function indexPath(scope: ContextPackingScope, attemptId: string): string {
  if (!scope.ownerId || !scope.harness || scope.workspaceId !== activeWorkspaceId() ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(attemptId)) throw new Error('context_packing_scope_invalid');
  return `evidence/context-packing/${hash(JSON.stringify(scope))}/${attemptId}.json`;
}

/** Immutable complete candidate population plus an attempt-keyed create-only
 * index. Same-attempt retries are idempotent; conflicting evidence is refused. */
export async function saveContextPackingReceipt(scope: ContextPackingScope, receipt: ContextPackingReceipt) {
  const path = indexPath(scope, receipt.attemptId);
  const content = JSON.stringify({ scope, receipt } satisfies StoredContextPackingReceipt);
  const artifact = await saveImmutableTextArtifact(scope.harness, content);
  const pointer = JSON.stringify({ sha256: artifact.sha256 });
  if (!await compareAndSwapTextArtifact(scope.harness, path, null, pointer) &&
      await loadTextArtifact(scope.harness, path) !== pointer) throw new Error('context_packing_attempt_conflict');
  return { attemptId: receipt.attemptId, path, ...artifact };
}

export async function loadContextPackingReceipt(scope: ContextPackingScope, attemptId: string): Promise<StoredContextPackingReceipt | null> {
  const path = indexPath(scope, attemptId);
  const pointer = await loadTextArtifact(scope.harness, path);
  if (!pointer) return null;
  const { sha256 } = JSON.parse(pointer);
  const content = await loadImmutableTextArtifact(scope.harness, sha256);
  if (!content) throw new Error('context_packing_artifact_missing');
  const stored = JSON.parse(content) as StoredContextPackingReceipt;
  if (JSON.stringify(stored.scope) !== JSON.stringify(scope) || stored.receipt.attemptId !== attemptId) {
    throw new Error('context_packing_artifact_scope_mismatch');
  }
  return stored;
}

/** Diagnostic pagination is out of band, including its JSON framing in D.
 * Base64 pages can split arbitrary metadata bytes without losing a long source
 * identity. Concatenate decoded data before parsing the complete UTF-8 ledger.
 * No candidate is discarded to fit a diagnostic page. */
export function pageContextPackingReceipt(stored: StoredContextPackingReceipt, offset = 0, maxBytes = 6000): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes > 6000 || maxBytes < 512) {
    throw new Error('context_packing_diagnostic_page_invalid');
  }
  const body = Buffer.from(JSON.stringify(stored), 'utf8');
  if (offset > body.length) throw new Error('context_packing_diagnostic_offset_invalid');
  const render = (length: number) => JSON.stringify({
    schemaVersion: 'context-packing-page-v1', attemptId: stored.receipt.attemptId,
    encoding: 'base64', sha256: hash(body.toString('utf8')), offset, totalBytes: body.length,
    nextOffset: offset + length < body.length ? offset + length : null,
    data: body.subarray(offset, offset + length).toString('base64'),
  });
  let low = 0, high = Math.min(body.length - offset, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (!low && offset < body.length) throw new Error('context_packing_diagnostic_framing_overflow');
  const page = render(low);
  if (Buffer.byteLength(page, 'utf8') > maxBytes) throw new Error('context_packing_diagnostic_framing_overflow');
  return page;
}
