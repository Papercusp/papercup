/**
 * answer-capture.ts — D-004, the loop-closer. When a question resolves, the
 * accepted answer is written back into an INDEXED knowledge surface so the NEXT
 * asker gets a SYNCHRONOUS knowledge-tier hit (coord:ask never has to interrupt
 * a peer for an already-answered question), and so the answer is not lost if the
 * original asker went idle.
 *
 * Why mem0 is the default target: coord:ask's knowledge tier queries TWO
 * surfaces — search:semantic (escalations/brainstorm/turns/decisions) + mem0.
 * Raw conversations are NOT in the search:semantic index today (the plan's known
 * coverage gap), so the loop closes ONLY through a writeback into an indexed
 * surface. mem0 is the reliable one: it is the SAME store coord:ask reads, scoped
 * by the same `harness:<slug>` / `workspace:<id>` pseudo-user keys, so a captured
 * answer is immediately findable. (harness_decisions / agent-insights are valid
 * alternative targets per D-004 but are a follow-on — mem0 already closes the
 * loop; see the conversations plan's optional "index conversations/issues"
 * follow-up.)
 *
 * Best-effort: a capture failure (mem0 unavailable) NEVER fails the resolve —
 * the accepted answer still lives on the conversation row. We report what
 * happened so the resolver/asker can see it.
 */

import { getMemoryClient } from '../../memory/mem0-client';
import type { ConversationScope } from './conversations-store';

export type CaptureTarget = 'mem0' | 'none';

export interface CaptureInput {
  target: CaptureTarget;
  question: string;
  answer: string;
  scope: ConversationScope;
  harness_slug: string | null;
  /** Workspace id (for the operator-scope mem0 pseudo-user key). */
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
 * The mem0 pseudo-user key a captured answer is written under, mirroring
 * memory:remember's scoping so coord:ask's mem0 read (which fans out over the
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

  // target === 'mem0'
  let client;
  try {
    client = await getMemoryClient();
  } catch {
    client = null;
  }
  if (!client) {
    return { target: 'mem0_unavailable', ok: false, detail: 'mem0 unavailable; answer kept on the conversation row only' };
  }

  const userId = captureMem0Key(input.scope, input.harness_slug, input.workspace_id);
  // Store as a Q→A fact so a semantic search on a paraphrase of the question
  // surfaces the answer. Anchor it to the source conversation for provenance.
  const content = `Q: ${input.question.trim()}\nA: ${input.answer.trim()}`;
  const metadata: Record<string, unknown> = {
    kind: 'project',
    scope: input.scope === 'harness' ? 'harness' : 'workspace',
    source: 'conversation',
    conversation_id: input.conversation_id,
    resolved_by: input.resolver_id,
    asked_by: input.asker_id,
  };
  if (input.scope === 'harness' && input.harness_slug) metadata.harness_slug = input.harness_slug;
  if (input.workspace_id) metadata.workspace_id = input.workspace_id;

  try {
    await client.add(content, { userId, metadata });
    return { target: `mem0:${userId}`, ok: true };
  } catch (err) {
    return { target: 'mem0_error', ok: false, detail: (err as Error).message };
  }
}
