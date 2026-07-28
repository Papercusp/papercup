/**
 * Grade action — a rubric picker that turns ON the 'grade' overlay mode
 * naming the chosen rubric (gui-chat-session-controls-2026-07-25 P-005).
 *
 * `params` is ASYNC because the option set is fetched at CLICK time from the
 * live rubrics store, via the same named sync-query cache the Rubrics tab
 * reads (`rubrics.list` — packages/operator-core/lib/sync-resolver/index.ts,
 * backed by lib/rubrics.ts listRubrics via a 2-min derived-read precompute).
 * `params()` is not a React hook, so it cannot call `useSyncQuery`; it uses
 * the imperative sibling `fetchSyncQuery` (@papercusp/sync,
 * libs/generic/sync/src/transports/polling/usePollingQuery.ts) — same cache
 * key, so this never double-fetches against an already-mounted
 * `useSyncQuery('rubrics.list')` reader elsewhere in the tree.
 *
 * chat-protocol stays domain-free: this action never teaches the wire
 * vocabulary what a rubric IS. It reuses the SAME `postModeSet` plumbing
 * P-004 built (./PostureActions) — the chosen rubric id/title rides in the
 * free-text `reason`, exactly like P-004's "owner set … from the chat action
 * bar" reasons. No new endpoint or schema.
 */
import { z } from 'zod';
import { fetchSyncQuery } from '@papercusp/sync';
import { registerChatAction } from './registry';
import { postModeSet } from './PostureActions';
import type { ChatActionContext } from './types';

/** The shape of one `rubrics.list` sync-query row (derived-read snapshot —
 *  packages/operator-core/lib/derived-reads/producers.ts). Only the fields
 *  this action reads are declared. */
interface RubricListRow {
  rubricId: string;
  characteristic: string;
  title: string;
  status: 'proposed' | 'active' | 'retired';
}

function ownerId(ctx: ChatActionContext): string {
  return ctx.sessionOwnerId;
}

registerChatAction({
  id: 'posture-grade',
  label: 'Grade',
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  params: async () => {
    const rows = await fetchSyncQuery<RubricListRow>({ queryName: 'rubrics.list', args: {} });
    const active = rows.filter((r) => r.status === 'active');
    return {
      // WI-6552 [owner:Avi 2026-07-27]: the prompt EXPLAINS what grade mode is
      // rather than just naming the input. The owner met this picker with no
      // idea what it would do ("something that comes up that explains what
      // grade mode is") — the workspace can hold a dozen active rubrics, so
      // "Pick a rubric" alone gave no clue what picking one commits them to.
      prompt:
        'Grade mode asks this agent to score its own work against a rubric — a named checklist of criteria — and report the result, instead of just carrying on. Choose which rubric it should grade against.',
      dataSchema: z.object({ picks: z.tuple([z.string().min(1)]) }),
      presentation: {
        // 'select', not 'radio': radio renders one full-width row per option
        // and this list is as long as the active-rubric set, which filled the
        // entire chat popup. Same answer shape either way.
        kind: 'select',
        placeholder: 'Grade',
        options: active.map((r) => ({
          id: r.rubricId,
          label: r.title,
          hint: r.characteristic,
        })),
      },
      allowDecline: true,
    };
  },
  run: async (ctx, value) => {
    const [rubricId] = (value as { picks: [string] }).picks;
    const agent = ownerId(ctx);
    await postModeSet(
      agent,
      'grade',
      true,
      `owner selected rubric ${rubricId} for grade mode from the chat action bar`,
    );
  },
});
