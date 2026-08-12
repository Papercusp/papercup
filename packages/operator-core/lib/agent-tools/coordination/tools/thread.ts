/**
 * coord:thread — read every coord entry connected via `related_msg_id`
 * to a given root, in time order.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readThread, resolveMessageRef } from '../messages';
import { projectAuthoredFields } from '../message-fields';
import { COORD_ROLES } from '../roles';
import { boundInboxEntries } from './inbox';

// A thread is a forensic read, but it is still an agent-facing result. Keep the
// normal response small enough to survive the ptool/MCP result door: retain the
// root plus the newest entries, and excerpt each content-bearing field. A caller
// that needs the complete message can use coord:read with the returned msg_id.
const THREAD_DEFAULT_ENTRY_LIMIT = 20;
const THREAD_CONTENT_BUDGET = 8_000;
const THREAD_CONTENT_CAP = 600;

function selectThreadWindow<T extends { msg_id?: string }>(
  entries: readonly T[],
  rootMsgId: string,
): T[] {
  if (entries.length <= THREAD_DEFAULT_ENTRY_LIMIT) return [...entries];

  const root = entries.find((entry) => entry.msg_id === rootMsgId);
  const tailCount = THREAD_DEFAULT_ENTRY_LIMIT - (root ? 1 : 0);
  const tail = entries.slice(-tailCount);
  const selected = new Set(tail);
  if (root) selected.add(root);

  // `entries` is already sorted by readThread. Filtering the selected objects
  // preserves that order while keeping the root visible even when it is old.
  return entries.filter((entry) => selected.has(entry));
}

export default defineTool({
  name: 'coord:thread',
  description:
    'Reconstruct a coord thread rooted at `root_msg_id`; pass the inbox entry\'s `msg_id` value as `root_msg_id` (there is no `msg_id` argument). Entries connected via `related_msg_id` are sorted by ts ascending.',
  guidance: {
    when: 'You want the full conversation around a coord message (replies, acks, resolutions). Use the exact `msg_id` from coord:inbox or coord:read as the `root_msg_id` argument.',
    notWhen: 'For a fresh inbox sweep — use coord:inbox.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    root_msg_id: z.string().min(1),
  }),
  async handler(args) {
    // WI-6725: a truncated root_msg_id used to walk a chain rooted at an id
    // that matches nothing and return `entries: []` — indistinguishable from a
    // thread that does not exist. Resolve the ref first (see resolveMessageRef).
    const resolution = await resolveMessageRef(args.root_msg_id);
    if (resolution.status === 'ambiguous') {
      return {
        data: {
          root: args.root_msg_id,
          entries: [],
          error: 'msg_id_ambiguous' as const,
          candidates: resolution.candidates,
          detail: `'${args.root_msg_id}' is a truncated msg_id matching ${resolution.candidates.length}+ messages — supply more of the id, or the full one from coord:inbox.`,
        },
      };
    }
    if (resolution.status === 'not-found') {
      return {
        data: {
          root: args.root_msg_id,
          entries: [],
          found: false,
          ...(resolution.looksTruncated
            ? {
                detail: `No message id starts with '${args.root_msg_id}'. Note this is NOT a full msg_id (expected '<short>-0000-<32 hex>') — if you copied it out of prose it may have been truncated at the source.`,
              }
            : {}),
        },
      };
    }
    const entries = await readThread(resolution.msgId);
    const window = selectThreadWindow(entries, resolution.msgId);
    const contentCap = Math.min(
      THREAD_CONTENT_CAP,
      Math.floor(THREAD_CONTENT_BUDGET / Math.max(1, window.length)),
    );
    // P-033 (e): same reason as coord:read — the authored structure rides the ENVELOPE
    // and the rendered `body` is a flattened text projection of it. A thread is where a
    // disagreement gets re-read, so it is the surface where "what did the sender say
    // this rested on" matters most. Attached per entry; absent when nothing authored.
    //
    // ⚠ Pass the entry, NOT `.extra` — see projectAuthoredFields. This read `.extra`
    // until 2026-08-02, so it attached `authored` to exactly zero entries.
    const withAuthored = boundInboxEntries(window, contentCap).map((entry) => {
      const authored = projectAuthoredFields(entry);
      return authored ? { ...entry, authored } : entry;
    });
    return {
      data: {
        root: resolution.msgId,
        entries: withAuthored,
        entries_shown: withAuthored.length,
        entries_total: entries.length,
        ...(withAuthored.length < entries.length
          ? {
              entries_truncated: true,
              detail:
                `Showing the root and newest ${THREAD_DEFAULT_ENTRY_LIMIT - 1} thread entries. ` +
                'Use coord:read for a complete individual message.',
            }
          : {}),
        ...(resolution.resolvedFrom === 'prefix'
          ? {
              requested_root: args.root_msg_id,
              resolved_from: 'prefix' as const,
              detail: `'${args.root_msg_id}' is a TRUNCATED msg_id — resolved by unique prefix to '${resolution.msgId}'.`,
            }
          : {}),
      },
    };
  },
});
