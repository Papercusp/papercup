/**
 * coord:read — fetch ONE coord message's FULL, untruncated envelope by
 * `msg_id`. EI-9942: coord:inbox's default render caps a body at ~600 chars
 * (`FULL_TIER.bodyChars` in tools/inbox.ts) so a normal inbox sweep never
 * overflows the agent result cap — but that leaves no CHEAP way to read back
 * the full text of ONE specific oversized finding. The 2026-07-12 p2p-ship
 * incident: a 2615-char root-cause report rendered truncated at ~550 chars;
 * the reader needed 2 extra fetch calls (including `payloadTier:'full'`,
 * which does not affect per-entry body truncation at all) and still never
 * saw the full body via coord — it only became readable once the sender
 * ALSO copied it onto a work-item's summary.
 *
 * Reuse-first: the full-body lookup already existed as `getMessageById`
 * (WI-3832 — an indexed `coord_event_log` fast-path read with a readLines
 * fallback), but it was wired ONLY into internal resolvers
 * (ref-hydrate-resolve, relay-provenance-resolve) — no tool exposed it.
 * `coord:thread { root_msg_id }` can ALSO return one message's full body
 * (`foldThread` degrades to a singleton when there is no `related_msg_id`
 * chain), but it always does a full un-indexed scan of the whole `messages`
 * surface (`coordLog.readLines('messages')`) and is framed as "reconstruct a
 * conversation" — not discoverable as "read one message's full text
 * cheaply". This tool is a thin, additive wrapper over the SAME
 * `getMessageById` used elsewhere — no change to coord:send's existing
 * behavior, no new storage, no new ledger.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMessageById } from '../messages';
import { COORD_ROLES } from '../roles';

export default defineTool({
  name: 'coord:read',
  description:
    "Fetch ONE coord message's FULL, untruncated body by `msg_id` — the cheap fix for a finding that rendered truncated in coord:inbox (its default ~600-char per-entry render cap). Returns { ok, found, msg_id, message } where `message` is the complete envelope (from/to/ts/kind/summary/body/files/…) with no truncation applied. `found:false` when no message with that id exists (never throws). Prefer checkpointing a substantive finding onto its work-item instead of relying on this — coord:read is the recovery path for a body that already went out oversized, not a substitute for the write-side discipline.",
  guidance: {
    when: 'A coord:inbox / coord:feed entry rendered with `body_truncated:true` (or you were told "see coord msg <id>") and you need its exact full text — one cheap lookup by msg_id instead of a since_ts poll or a payloadTier:"full" retry (payloadTier does not affect per-entry body truncation).',
    notWhen: 'For the whole conversation around a message (replies/acks/resolutions) — use coord:thread. For a fresh inbox sweep — use coord:inbox. Before SENDING a long finding — write it onto the work-item (work_items:checkpoint / a comment) and send only a 1-line pointer; do not rely on the recipient coord:read-ing it back.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    msg_id: z.string().min(1).describe('The coord message id to fetch in full (as seen on a coord:inbox/coord:feed entry, or returned by coord:send).'),
  }),
  async handler(args) {
    const message = await getMessageById(args.msg_id);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, found: message !== null, msg_id: args.msg_id, message }),
        },
      ],
    };
  },
});
