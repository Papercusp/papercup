/**
 * Compensation adapter for migration 1063's `attention-bulk-item` handles.
 *
 * The handle points at the immutable per-item receipt. This module resolves the
 * receipt under the store's row lock and restores the source condition through
 * the existing persistence surfaces. Reversal never deletes or rewrites the
 * original action audit; the store appends reverted_at/revert_note only after
 * the source compensation succeeds.
 */
import type { RevertHandle } from '../autonomy/tripwire/core';
import type { RevertOutcome } from '../autonomy/tripwire/scan';
import {
  ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND,
  executeBulkRunItemReversal,
} from './bulk-run-store';
import { terminalPolicyFor } from './terminal-coverage';
import { clearTriage } from './triage-store';

function field(handle: RevertHandle, key: string): string | null {
  const value = handle[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Shared registry target used by autonomy/tripwire/revert-executor. */
export async function revertAttentionBulkItemHandle(handle: RevertHandle): Promise<RevertOutcome> {
  const workspaceId = field(handle, 'workspaceId');
  const runId = field(handle, 'runId');
  const itemId = field(handle, 'itemId');
  if (
    handle.kind !== ATTENTION_BULK_ITEM_REVERT_HANDLE_KIND ||
    !workspaceId ||
    !runId ||
    !itemId
  ) {
    return { reverted: false, note: 'invalid attention-bulk-item pointer' };
  }

  try {
    const outcome = await executeBulkRunItemReversal({
      workspaceId,
      runId,
      itemId,
      async execute(item, sql) {
        const sourceKind = item.kind ?? field({ kind: '', ...item.ref }, 'kind');
        const policy = sourceKind ? terminalPolicyFor(sourceKind) : null;
        if (policy?.class !== 'acknowledgement') {
          throw new Error(
            `source-mutating compensation for '${sourceKind ?? '(unknown)'}' is not registered`,
          );
        }

        // Acknowledgement-class actions terminate by writing attention_triage.
        // The exact inverse is the existing clearTriage operation, joined to
        // the same transaction as reverted_at/revert_note.
        await clearTriage(item.itemId, workspaceId, sql);
        return {
          result: null,
          note: `cleared acknowledgement triage for ${item.itemId}`,
        };
      },
    });
    if (outcome.refused) {
      return { reverted: false, note: `attention bulk reversal refused: ${outcome.refused}` };
    }
    return {
      reverted: true,
      note: outcome.item?.revertNote ?? `reverted attention bulk item ${itemId}`,
    };
  } catch (error) {
    return {
      reverted: false,
      note: error instanceof Error ? error.message : String(error),
    };
  }
}
