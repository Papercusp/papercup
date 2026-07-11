/**
 * relay-provenance-resolve.ts — the IO half of ./relay-provenance (P-004 / H2):
 * resolve a sender's `relayOf` / `relayQuote` into a platform-verified stamp,
 * SERVER-SIDE, at send time. Zero extra tool calls for the sender; the
 * receiver just reads the stamped envelope.
 *
 *   Tier 1  relayOf: <msg_id>       → load the origin coord message, verify it
 *           exists, capture its text verbatim, extend its chain to root.
 *           A MISS is a LOUD error (relay_origin_not_found): the sender named a
 *           specific id — refusing beats laundering a dangling reference.
 *   Tier 2  relayOf: "owner-turn"   → resolve the CALLER's live transcript
 *           (search/self-session) and capture the human turn it is currently
 *           answering — verbatim, platform-read, never the sender's paraphrase.
 *           Spike-verified 2026-07-11: the human turn is durable at turn START
 *           (~ms lag), so a mid-turn send always sees it. Unresolvable (no pty
 *           record, no transcript, no human turn) → fall to Tier 3 when a
 *           relayQuote was also given, else a loud-but-delivered `unverified`.
 *   Tier 3  relayQuote: "<snippet>" → verify the snippet appears as a HUMAN
 *           turn in the caller's own transcript (normalized substring);
 *           hit → owner-verified(transcript-match), miss → `unverified`
 *           (delivered, loudly stamped — never blocked).
 *
 * Fail-soft BY CONTRACT except the tier-1 dangling id: an IO hiccup degrades
 * the stamp (unverified), never blocks the send.
 */

import { open } from 'node:fs/promises';
import type { AgentIdentity } from './identity';
import { getMessageById } from './messages';
import { resolveSelfSession } from '../../search/self-session';
import { clampSnippet } from './ref-hydrate';
import {
  OWNER_TURN_SENTINEL,
  RELAY_QUOTE_CHARS,
  readRelayProvenance,
  type RelayProvenanceStamp,
} from './relay-provenance';

/** Multi-hop chain cap — bounds the stamp size on a relay-of-relay-of-… */
const CHAIN_MAX = 8;
/** Tier 2 reads the transcript TAIL (the current turn is always near the end). */
const TAIL_BYTES = 512 * 1024;
/** Tier 3 scans at most this much of the transcript tail. */
const SCAN_BYTES = 4 * 1024 * 1024;

export interface RelayResolveResult {
  stamp: RelayProvenanceStamp | null;
  /** Tier-1 LOUD failure: the named origin msg_id does not exist. */
  error?: 'relay_origin_not_found';
}

/** A human turn parsed from a session JSONL. */
interface HumanTurn {
  ts: string;
  text: string;
}

/** Harness-synthetic user entries that are NOT owner words (local-command
 *  echoes, caveats, command stdout, post-compaction continuation plumbing). */
const SYNTHETIC_MARKERS = [
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
];

function isSyntheticTurn(text: string): boolean {
  const head = text.slice(0, 200);
  return SYNTHETIC_MARKERS.some((m) => head.includes(m));
}

/** Parse the human (owner-typed) turns out of raw JSONL text, in file order.
 *  Skips tool_result-only user entries, isMeta rows, and synthetic turns. */
export function parseHumanTurns(jsonl: string): HumanTurn[] {
  const out: HumanTurn[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn first line of a tail read / corrupt row
    }
    if (o.type !== 'user' || o.isMeta === true) continue;
    const m = (o.message ?? {}) as Record<string, unknown>;
    const c = m.content;
    let text: string;
    if (typeof c === 'string') {
      text = c;
    } else if (Array.isArray(c)) {
      const texts = c
        .filter(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
        )
        .map((b) => b.text);
      if (!texts.length) continue; // tool_result-only plumbing
      text = texts.join('\n');
    } else {
      continue;
    }
    if (!text.trim() || isSyntheticTurn(text)) continue;
    out.push({ ts: typeof o.timestamp === 'string' ? o.timestamp : '', text });
  }
  return out;
}

/** Read the last `bytes` of a file (whole file when smaller). */
async function readTail(filePath: string, bytes: number): Promise<string> {
  const fh = await open(filePath, 'r');
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Whitespace/case-normalize for the tier-3 verbatim containment check. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function readCallerHumanTurns(
  ownerId: string,
  bytes: number,
): Promise<{ sessionId: string; turns: HumanTurn[] } | null> {
  const self = await resolveSelfSession(ownerId).catch(() => null);
  if (!self) return null;
  try {
    const tail = await readTail(self.filePath, bytes);
    return { sessionId: self.sessionId, turns: parseHumanTurns(tail) };
  } catch {
    return null;
  }
}

/**
 * Resolve the sender's relay reference into a verified stamp. `null` stamp when
 * neither relayOf nor relayQuote was passed (an ordinary, non-relay send).
 */
export async function resolveRelayProvenance(
  identity: AgentIdentity,
  opts: { relayOf?: string; relayQuote?: string },
): Promise<RelayResolveResult> {
  const relayOf = opts.relayOf?.trim();
  const relayQuote = opts.relayQuote?.trim();
  if (!relayOf && !relayQuote) return { stamp: null };

  // ── Tier 1: coord-origin relay ──
  if (relayOf && relayOf !== OWNER_TURN_SENTINEL) {
    const origin = await getMessageById(relayOf).catch(() => null);
    if (!origin) return { stamp: null, error: 'relay_origin_not_found' };
    const env = origin as unknown as Record<string, unknown>;
    // Relay-of-relay: extend the ORIGIN's own verified chain (root first).
    const originStamp = readRelayProvenance(env);
    const chain = [...(originStamp?.chain ?? []), relayOf].slice(-CHAIN_MAX);
    const content = [origin.summary, origin.body].filter(Boolean).join(' — ');
    return {
      stamp: {
        tier: 'coord-origin',
        quote: clampSnippet(content, RELAY_QUOTE_CHARS),
        originMsgId: relayOf,
        chain,
        origin: originStamp?.origin ?? 'agent',
      },
    };
  }

  // ── Tier 2: owner-turn sentinel — capture the caller's current human turn ──
  if (relayOf === OWNER_TURN_SENTINEL) {
    const read = await readCallerHumanTurns(identity.ownerId, TAIL_BYTES);
    const last = read?.turns.length ? read.turns[read.turns.length - 1] : null;
    if (read && last) {
      return {
        stamp: {
          tier: 'owner-verified-turn',
          quote: clampSnippet(last.text, RELAY_QUOTE_CHARS),
          origin: 'owner',
          sessionId: read.sessionId,
          ...(last.ts ? { turnTs: last.ts } : {}),
        },
      };
    }
    // Live window unreachable → Tier 3 covers it when a quote was supplied.
    if (!relayQuote) return { stamp: { tier: 'unverified', quote: '' } };
  }

  // ── Tier 3: sender-supplied quote, verified against the caller's transcript ──
  if (relayQuote) {
    const read = await readCallerHumanTurns(identity.ownerId, SCAN_BYTES);
    const needle = normalize(relayQuote);
    const hit =
      needle.length > 0 && (read?.turns.some((t) => normalize(t.text).includes(needle)) ?? false);
    return {
      stamp: {
        tier: hit ? 'owner-verified-transcript' : 'unverified',
        quote: clampSnippet(relayQuote, RELAY_QUOTE_CHARS),
        ...(hit ? { origin: 'owner' as const } : {}),
        ...(read?.sessionId && hit ? { sessionId: read.sessionId } : {}),
      },
    };
  }

  return { stamp: null };
}
