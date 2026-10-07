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
import { trimToByteBudget } from '../../_bound-output';

// A thread is a forensic read, but it is still an agent-facing result. Keep the
// normal response small enough to survive the ptool/MCP result door: retain the
// root plus the newest entries, and excerpt each content-bearing field. A caller
// that needs the complete message can use coord:read with the returned msg_id.
const THREAD_DEFAULT_ENTRY_LIMIT = 20;
const THREAD_CONTENT_BUDGET = 8_000;
const THREAD_CONTENT_CAP = 600;
// The MCP result door cuts near 6,000 chars and appends its own disclosure.
// Leave headroom so coord:thread returns complete JSON before it reaches that door.
export const THREAD_RESPONSE_BUDGET_CHARS = 4_800;

/**
 * `CoordEnvelope` is intentionally open-ended (`[key: string]: unknown`) so
 * typed coordination verbs can attach kind-specific fields. That is the right
 * storage shape, but it is unsafe to spread into this bounded read surface:
 * one diagnostic/blob field can outweigh the content budget and leave the MCP
 * result door with an incomplete JSON document. Keep the fields a thread reader
 * can act on here; `coord:read` remains the escape hatch for the complete
 * individual envelope.
 */
const THREAD_ENTRY_FIELDS = new Set([
  // Core identity, routing, and content.
  'ts',
  'msg_id',
  'from',
  'to',
  'audience',
  'kind',
  'summary',
  'summary_truncated',
  'summary_full_chars',
  'body',
  'body_truncated',
  'body_full_chars',
  'sections',
  'sections_truncated',
  'sections_full_chars',
  'category',
  'files',
  'commit',
  'plan_slug',
  'harness_slug',
  'related_msg_id',
  'expectsReply',
  // Envelope-authored fields surfaced by projectAuthoredFields.
  'expects',
  'blocking',
  'why',
  'basedOn',
  'authored',
  // Common lifecycle/status fields used by thread kinds.
  'ack_for',
  'acked',
  'acked_from',
  'ack_msg_id',
  'condition_key',
  'resolves_condition',
  'resolved',
  'resolved_at',
  'severity',
  'options',
  'retracted',
  'retracts_msg_id',
  'auto',
  'lifecycle',
  'origin',
  'remote_origin_note',
]);

/** Remove open-ended extension fields before a thread entry reaches JSON/MCP. */
function compactThreadEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let omitted = 0;
  for (const [key, value] of Object.entries(entry)) {
    if (!THREAD_ENTRY_FIELDS.has(key)) {
      omitted += 1;
      continue;
    }
    out[key] = value;
  }
  if (omitted > 0) {
    out.thread_metadata_truncated = true;
    out.thread_metadata_fields_omitted = omitted;
  }
  return out;
}

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

/** Keep core sender/message details if one entry alone exceeds the result budget. */
function minimalThreadEntryForBudget(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of ['ts', 'msg_id', 'from', 'kind', 'related_msg_id'] as const) {
    const value = entry[field];
    if (typeof value === 'string') out[field] = value;
  }

  if (Array.isArray(entry.to)) {
    out.to = entry.to.slice(0, 8).map((recipient) =>
      typeof recipient === 'string' && recipient.length > 160
        ? `${recipient.slice(0, 159)}…`
        : recipient,
    );
    if (entry.to.length > 8) {
      out.to_truncated = true;
      out.to_total = entry.to.length;
    }
  }

  for (const field of ['summary', 'body'] as const) {
    const value = entry[field];
    if (typeof value !== 'string') continue;
    const maxChars = 160;
    out[field] = value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
    if (value.length > maxChars) {
      out[`${field}_truncated`] = true;
      const fullChars = entry[`${field}_full_chars`];
      out[`${field}_full_chars`] = typeof fullChars === 'number' ? fullChars : value.length;
    }
  }

  out.thread_entry_truncated = true;
  out.thread_entry_full_chars = JSON.stringify(entry).length;
  out.thread_entry_detail = 'Use coord:read with this msg_id to retrieve the complete envelope.';
  return out;
}

/** Fit a thread to the agent result door, prioritizing its root and newest entries. */
function fitThreadResponse(
  entries: Array<Record<string, unknown>>,
  rootMsgId: string,
  entriesTotal: number,
  prefix?: { requestedRoot: string; detail: string },
): Record<string, unknown> {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const root = indexed.find(({ entry }) => entry.msg_id === rootMsgId);
  const priority = root
    ? [root, ...indexed.filter(({ entry }) => entry !== root.entry).reverse()]
    : [...indexed].reverse();
  const indexByEntry = new Map(indexed.map(({ entry, index }) => [entry, index]));
  let selected = trimToByteBudget(
    priority.map(({ entry }) => entry),
    THREAD_RESPONSE_BUDGET_CHARS,
  ).kept.map((entry) => ({ entry, index: indexByEntry.get(entry) ?? 0 }));
  let contentTruncated = false;

  const build = (): Record<string, unknown> => {
    const shown = [...selected]
      .sort((a, b) => a.index - b.index)
      .map(({ entry }) => entry);
    const entriesTruncated = shown.length < entriesTotal;
    const details = [
      ...(entriesTruncated || contentTruncated
        ? [
            'Showing the root and newest thread entries that fit the result budget or default window. ' +
              'Use coord:read with an entry msg_id to retrieve its complete envelope.',
          ]
        : []),
      ...(prefix ? [prefix.detail] : []),
    ];
    return {
      root: rootMsgId,
      entries: shown,
      entries_shown: shown.length,
      entries_total: entriesTotal,
      ...(entriesTruncated ? { entries_truncated: true } : {}),
      ...(contentTruncated ? { content_truncated: true } : {}),
      ...(prefix
        ? { requested_root: prefix.requestedRoot, resolved_from: 'prefix' as const }
        : {}),
      ...(details.length ? { detail: details.join(' ') } : {}),
    };
  };

  let data = build();
  while (JSON.stringify(data).length > THREAD_RESPONSE_BUDGET_CHARS && selected.length > 1) {
    selected = selected.slice(0, -1);
    data = build();
  }

  if (JSON.stringify(data).length > THREAD_RESPONSE_BUDGET_CHARS && selected.length === 1) {
    const only = selected[0]!;
    selected = [{ ...only, entry: minimalThreadEntryForBudget(only.entry) }];
    contentTruncated = true;
    data = build();
  }

  // The minimal row is deliberately small; this final identity-only fallback
  // protects the result contract if an unexpected core field is itself huge.
  if (JSON.stringify(data).length > THREAD_RESPONSE_BUDGET_CHARS && selected.length === 1) {
    const only = selected[0]!;
    selected = [
      {
        ...only,
        entry: {
          ...(typeof only.entry.msg_id === 'string' ? { msg_id: only.entry.msg_id } : {}),
          ...(typeof only.entry.kind === 'string' ? { kind: only.entry.kind } : {}),
          thread_entry_truncated: true,
        },
      },
    ];
    data = build();
  }

  return data;
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
  // The coordination log seam owns its own read handle; keeping the dispatcher's
  // ambient workspace transaction open while a thread is reconstructed can idle it
  // past idle_in_transaction_session_timeout on a busy fleet.
  skipWorkspaceTx: true,
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
      const out = { ...entry };
      // Do not let a legacy/open-envelope `authored` extension survive when
      // there is no valid projected authored structure to replace it.
      if (authored) out.authored = authored;
      else delete out.authored;
      return compactThreadEntry(out);
    });
    const fitted = fitThreadResponse(
      withAuthored,
      resolution.msgId,
      entries.length,
      resolution.resolvedFrom === 'prefix'
        ? {
            requestedRoot: args.root_msg_id,
            detail: `'${args.root_msg_id}' is a TRUNCATED msg_id — resolved by unique prefix to '${resolution.msgId}'.`,
          }
        : undefined,
    );
    return { data: fitted };
  },
});
