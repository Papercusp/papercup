/**
 * answer-capture.ts — D-004, the loop-closer. When a question resolves, the
 * accepted answer is written back into an INDEXED knowledge surface so the NEXT
 * asker gets a SYNCHRONOUS knowledge-tier hit (coord:ask never has to interrupt
 * a peer for an already-answered question), and so the answer is not lost if the
 * original asker went idle.
 *
 * Why the memory store is the default target: coord:ask's knowledge tier queries
 * TWO surfaces — search:semantic (escalations/brainstorm/turns/decisions) + the
 * persistent memory store. Raw conversations are NOT in the search:semantic index
 * today (the plan's known coverage gap), so the loop closes ONLY through a
 * writeback into an indexed surface. The memory store is the reliable one: it is
 * the SAME store coord:ask reads, scoped by the same `harness:<slug>` /
 * `workspace:<id>` pseudo-user keys, so a captured answer is immediately
 * findable. (harness_decisions / agent-insights are valid alternative targets per
 * D-004 but are a follow-on; see the conversations plan's optional "index
 * conversations/issues" follow-up.)
 *
 * Storage rides the neutral `MemoryBackend` seam (generalize-memory-backend-
 * swappable D-003). The `mem0`/`mem0_*` wire literals are kept for surface
 * stability (the capture-target enum + result strings are agent-visible) even
 * though the store behind them is now swappable.
 *
 * Best-effort: a capture failure (store unavailable) NEVER fails the resolve —
 * the accepted answer still lives on the conversation row. We report what
 * happened so the resolver/asker can see it.
 */

import { getMemoryBackend } from '../../memory/backend';
import type { ConversationScope } from './conversations-store';

export type CaptureTarget = 'mem0' | 'none';

export interface CaptureInput {
  target: CaptureTarget;
  question: string;
  answer: string;
  scope: ConversationScope;
  harness_slug: string | null;
  /** Workspace id (for the operator-scope pseudo-user key). */
  workspace_id?: string | null;
  asker_id: string;
  resolver_id: string;
  conversation_id: string;
}

export interface CaptureResult {
  /** What actually happened: the target written, or why it didn't. */
  target: string;
  ok: boolean;
  detail?: string;
}

/**
 * The memory-pool key a captured answer is written under, mirroring
 * memory:remember's scoping so coord:ask's memory read (which fans out over the
 * same keys) finds it:
 *   harness scope   → `harness:<slug>`
 *   operator scope  → `workspace:<workspace_id>`
 */
export function captureMem0Key(scope: ConversationScope, harnessSlug: string | null, workspaceId: string | null | undefined): string {
  if (scope === 'harness' && harnessSlug) return `harness:${harnessSlug}`;
  return `workspace:${workspaceId ?? 'default'}`;
}

export async function captureResolvedAnswer(input: CaptureInput): Promise<CaptureResult> {
  if (input.target === 'none') {
    return { target: 'none', ok: true, detail: 'capture skipped by resolver' };
  }

  // target === 'mem0' (the persistent memory store, whichever backend serves it)
  const backend = getMemoryBackend();
  let available = false;
  try {
    available = (await backend.available()).ok;
  } catch {
    available = false;
  }
  if (!available) {
    return { target: 'mem0_unavailable', ok: false, detail: 'memory store unavailable; answer kept on the conversation row only' };
  }

  const scopeKey = captureMem0Key(input.scope, input.harness_slug, input.workspace_id);
  // Store as a Q→A fact so a semantic search on a paraphrase of the question
  // surfaces the answer. Anchor it to the source conversation for provenance.
  const content = `Q: ${input.question.trim()}\nA: ${input.answer.trim()}`;
  const metadata: Record<string, unknown> = {
    scope: input.scope === 'harness' ? 'harness' : 'workspace',
    source: 'conversation',
    conversation_id: input.conversation_id,
    resolved_by: input.resolver_id,
    asked_by: input.asker_id,
  };
  if (input.scope === 'harness' && input.harness_slug) metadata.harness_slug = input.harness_slug;
  if (input.workspace_id) metadata.workspace_id = input.workspace_id;

  try {
    const res = await backend.remember(content, { scope: scopeKey, kind: 'project', metadata });
    // A resolved promise is NOT proof of storage: mem0 swallows its LLM
    // extraction failures internally and resolves with zero events (EI-25).
    // Report an honest failure so the resolver knows the loop did not close —
    // a false "captured ok" is worse than a visible miss.
    const stored = res.storedEvents ?? res.ids.length;
    if (stored === 0) {
      return {
        target: 'mem0_no_store',
        ok: false,
        detail:
          'memory backend resolved but persisted nothing (extraction failed or declined — check the operator log); answer kept on the conversation row only',
      };
    }
    return { target: `mem0:${scopeKey}`, ok: true };
  } catch (err) {
    return { target: 'mem0_error', ok: false, detail: (err as Error).message };
  }
}
