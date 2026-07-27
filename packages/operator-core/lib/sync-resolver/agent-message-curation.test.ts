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
import { AGENT_SESSION_ID_HEX_RUN } from './index';

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
