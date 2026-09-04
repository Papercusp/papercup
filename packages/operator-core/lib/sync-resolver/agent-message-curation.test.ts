// conversations.agentMessageList curation predicate
// (conversations-agent-messages-2026-07-27 P-008).
//
// The Convos pane exists because the owner could not see agent↔agent traffic
// ("I see agents sending messages to each other all the time but I only see 51
// chat messages"). The first end-to-end probe after the resolver landed showed
// the OPPOSITE failure: 51,462 "conversations", of which only 7,452 (14.5%)
// were messages an agent actually wrote. The top of the pane was `now working
// on:` intent declares and `[fed-event] pot-git:ref-announce`.
//
// Two exclusions fix that, and this file pins the second one — the sender
// classifier — because it is the one a well-meaning "tighten the filter" edit
// can silently break in the direction that costs the owner data.
//
// The rule under test: an agent session id carries a high-entropy hex run; a
// service slug is words-joined-by-hyphens. Critically it FAILS OPEN — anything
// unrecognised stays visible, because the original bug was under-seeing.

import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_ID_HEX_RUN, toAgentMessageRow } from './index';

/** Mirrors the Postgres `~*` test applied in the resolver's WHERE clause. */
const looksLikeAgentSession = (sender: string): boolean =>
  new RegExp(AGENT_SESSION_ID_HEX_RUN, 'i').test(sender);

describe('agent-message curation: sender classifier', () => {
  // Every id shape observed in the live corpus on 2026-07-27. A whitelist
  // regex over the modern `su-<uuid>` form alone would have dropped the legacy
  // and bare-UUID senders — real agent messages, silently hidden.
  it.each([
    ['modern session id', 'su-40f20db0-4ce4-4278-bc20-cb9d913405aa'],
    ['peer session id', 'su-055aef7f-b4be-41a4-bbdb-1068c9fc79e3'],
    ['legacy epoch session id', 's-1784004323664-25c58084'],
    ['bare uuid sender', 'b9df5beb-7d57-4854-ba96-e9ec6e88877f'],
    ['bare uuid sender (2)', '81806c32-5eca-4f6a-a18e-a262fa4f78ad'],
  ])('keeps an agent-authored message: %s', (_label, sender) => {
    expect(looksLikeAgentSession(sender)).toBe(true);
  });

  // The named service actors that write plain, un-`auto`-stamped messages, so
  // the `auto:true` exclusion never reaches them. These are what the owner was
  // shown at the top of the pane before this fix.
  it.each([
    ['health prober', 'service-health'],
    ['governor', 'rate-governor'],
    ['gate', 'green-checkpoint'],
    ['git-sync announce', 'git-sync-ref-announce'],
    ['git-sync integrator', 'git-sync-integrator'],
    ['claim watchdog', 'claim-discipline-watch'],
    ['compaction watchdog', 'compaction-watchdog'],
    ['plan watchdog', 'plan-clobber-watch'],
    ['canary', 'coord-probe-canary-a'],
    ['deploy', 'release-deploy'],
    ['operator itself', 'operator'],
    // Both begin `su-` but are services, not sessions — which is exactly why
    // the classifier keys on the hex run and not on the id prefix.
    ['su-prefixed service', 'su-ideate-revision-wake'],
    ['su-prefixed probe', 'su-live1-imac-probe'],
  ])('excludes machine traffic: %s', (_label, sender) => {
    expect(looksLikeAgentSession(sender)).toBe(false);
  });

  it('fails OPEN for an unrecognised sender carrying a session-shaped id', () => {
    // A future actor nobody enumerated. If it looks like a session it stays
    // visible: the cost of a wrong guess must be noise, never a conversation
    // the owner cannot see. This is the asymmetry the whole plan turns on.
    expect(looksLikeAgentSession('newkind-9f3c1a77-0000-4a1b-9d2e-77aa10bc0011')).toBe(true);
  });

  it('does not classify a hyphenated service word-slug as a session', () => {
    // Guards the one theoretical false positive: an all-hex English word run.
    // Service slugs are words, and words do not reach 8 consecutive hex chars.
    expect(looksLikeAgentSession('some-new-background-service')).toBe(false);
    expect(looksLikeAgentSession('cache-decade-facade')).toBe(false);
  });
});

// ── WI-7240: the list/detail split of `authored` ────────────────────────────
//
// `toAgentMessageRow` is SHARED by `conversations.agentMessageList` and
// `.agentMessageDetail`. P-033 added the `authored` block to it for the DETAIL
// views, and the LIST silently inherited 188,386 B (43.90% of a 445,731 B
// payload) that nothing reads — both `<AuthoredFields>` render sites take their
// row from the detail query.
//
// These pin BOTH halves. Pinning only the list would let a future edit quietly
// drop `authored` from the detail read too, which is the regression that would
// actually cost a user something.

const ENVELOPE = {
  kind: 'ask',
  from: 'su-1a2b3c4d-0000-4a1b-9d2e-77aa10bc0011',
  to: ['su-9f8e7d6c-1111-4a1b-9d2e-77aa10bc0011'],
  summary: 'A one-line summary for the inbox',
  body: 'The long form of the message.',
  plan_slug: 'some-plan-2026-08-02',
  lifecycle: 'intent',
  audience: ['@object:issue:WI-1'],
  // The authored block rides the ENVELOPE top level (never `extra`).
  expects: 'action',
  blocking: true,
  why: { goalRef: 'WI-7240', note: 'because the mapper is shared' },
  basedOn: [{ ref: 'work-item:WI-7240', via: 'work_items:get', readAt: '2026-08-03T00:00:00.000Z' }],
};

const ROW = { msg_id: 'm-1', ts: '2026-08-03T00:00:00.000Z', harness_slug: 'papercusp', body: ENVELOPE, reply_count: 2, last_reply_ts: null };

/** Exactly what `composeUnifiedConversationRows` reads off a list row. */
const LIST_READ_SET = [
  'msg_id', 'kind', 'from', 'to', 'broadcast', 'summary', 'body',
  'harness_slug', 'plan_slug', 'lifecycle', 'audience', 'reply_count', 'ts', 'last_reply_ts',
] as const;

describe('agent-message row projection: authored is DETAIL-only (WI-7240)', () => {
  it('OMITS the authored KEY from a list row — absence, not a null', () => {
    const row = toAgentMessageRow(ROW, { includeAuthored: false });
    // Key ABSENCE is the assertion that matters: `authored: null` would still be
    // 100 keys on the wire and would read as "cut" when it is not.
    expect('authored' in row).toBe(false);
    expect(Object.keys(row)).not.toContain('authored');
  });

  it('KEEPS authored on a detail row, with the envelope fields projected', () => {
    const row = toAgentMessageRow(ROW);
    expect('authored' in row).toBe(true);
    expect(row.authored).toMatchObject({
      expects: 'action',
      blocking: true,
      why: { goalRef: 'WI-7240' },
    });
    expect((row.authored as { basedOn?: unknown[] }).basedOn).toHaveLength(1);
  });

  it('leaves every field the list composer reads intact in BOTH shapes', () => {
    const list = toAgentMessageRow(ROW, { includeAuthored: false });
    const detail = toAgentMessageRow(ROW);
    for (const key of LIST_READ_SET) {
      expect(list).toHaveProperty(key);
      expect(list[key]).toEqual(detail[key]);
    }
  });

  it('degrades to the FULL row when opts is not an options object', () => {
    // `rows.map(toAgentMessageRow)` passes the array INDEX as the second arg.
    // Reading `.includeAuthored` off a number gives undefined, so the mistake
    // yields the complete row rather than silently dropping a field — the safe
    // direction for a mapper two resolvers share.
    const asMapped = toAgentMessageRow(
      ROW,
      0 as unknown as { includeAuthored?: boolean; includeBody?: boolean },
    );
    expect('authored' in asMapped).toBe(true);
  });

  it('omits the long body from the default list projection but keeps it for a search result', () => {
    const list = toAgentMessageRow(ROW, { includeAuthored: false, includeBody: false });
    expect('body' in list).toBe(false);

    const searched = toAgentMessageRow(ROW, { includeAuthored: false, includeBody: true });
    expect(searched.body).toBe(ENVELOPE.body);
  });
});
