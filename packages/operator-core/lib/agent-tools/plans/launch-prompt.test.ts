/**
 * launch-prompt.test.ts — pot-seat-pools-prose-ux-2026-07-18 P-007/P-013/P-014:
 * the routing-gate's option (C) text, folded by `remoteSeats`
 * (RemoteSeatSummary). Also guards the pre-existing named-verb discipline
 * (sessions 9870/9865 — option C must always name `fleet:launch-on-plan`).
 *
 * What a regression here breaks: a shared pot with real donated seats never
 * gets told to the owner (P-007 silently regresses to local-only text), or an
 * unshared/local workspace starts mentioning remote seats that don't exist.
 *
 * Pure — no PG, no mocks needed.
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/launch-prompt.test.ts
 */
import { describe, expect, it } from 'vitest';
import { deriveLaunchPromptText, type RemoteSeatSummary } from './launch-prompt';

const PLAN = { slug: 'p-1', harness: 'papercusp' };

const UNSHARED: RemoteSeatSummary = { potShared: false, donorCount: 0, totalSeats: 0 };
const SHARED_EMPTY: RemoteSeatSummary = { potShared: true, donorCount: 0, totalSeats: 0 };
const SHARED_WITH_OFFERS: RemoteSeatSummary = { potShared: true, donorCount: 3, totalSeats: 7 };
const SHARED_SINGULAR: RemoteSeatSummary = { potShared: true, donorCount: 1, totalSeats: 1 };

describe('deriveLaunchPromptText — routing gate option (C), AUTO-off + plan bound', () => {
  it('omitted remoteSeats ⇒ byte-identical to the pre-P-007 static text (full profile)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full');
    expect(text).toContain(
      '(C) launch a fleet of agents to parallelize it (executed in ONE call with the ' +
        '`fleet:launch-on-plan` tool — never a hand-built psu command)',
    );
    expect(text).not.toContain('remote seats');
  });

  it('omitted remoteSeats ⇒ byte-identical static text (lean profile)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'lean');
    expect(text).toContain(
      '(C) launch a fleet of agents to parallelize it (executed in ONE call with the ' +
        '`fleet:launch-on-plan` tool — never a hand-built psu command)',
    );
  });

  it('unshared pot (potShared:false) ⇒ same static text as omitted, in both profiles', () => {
    const full = deriveLaunchPromptText(null, false, PLAN, 'full', UNSHARED);
    const lean = deriveLaunchPromptText(null, false, PLAN, 'lean', UNSHARED);
    expect(full).toContain('(C) launch a fleet of agents to parallelize it');
    expect(lean).toContain('(C) launch a fleet of agents to parallelize it');
  });

  it('shared pot with open offers ⇒ names fleet:launch-on-plan + placement:remote, discloses count/donors, asks about own slots (P-013/P-014)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', SHARED_WITH_OFFERS);
    expect(text).toContain('`fleet:launch-on-plan`');
    expect(text).toContain("placement:'remote'");
    expect(text).toContain('I see 7 agent slots available from 3 peers in this pot');
    expect(text).toContain('add their own agent slots to this fleet too');
    expect(text).toContain('resource:delegate');
    expect(text).toContain('p2p:trace');
  });

  it('singular counts use singular nouns ("1 agent slot", "1 peer")', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', SHARED_SINGULAR);
    expect(text).toContain('I see 1 agent slot available from 1 peer in this pot');
  });

  it('shared pot with an EMPTY inventory is not a dead end — still offers to create locally and names the peer-ask (P-013)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'full', SHARED_EMPTY);
    expect(text).toContain('`fleet:launch-on-plan`');
    expect(text).toContain('no standing remote seat offers yet');
    expect(text).toContain('resource:delegate');
    // no offers yet ⇒ no false donor-count disclosure
    expect(text).not.toContain('I see 0 agent slots');
  });

  it('lean profile also folds remoteSeats into option (C)', () => {
    const text = deriveLaunchPromptText(null, false, PLAN, 'lean', SHARED_WITH_OFFERS);
    expect(text).toContain("placement:'remote'");
    expect(text).toContain('I see 7 agent slots available from 3 peers in this pot');
  });

  it('AUTO-on branches are unaffected by remoteSeats (no routing-gate presentation happens there)', () => {
    const text = deriveLaunchPromptText(null, true, PLAN, 'full', SHARED_WITH_OFFERS);
    expect(text).not.toContain('routing gate');
    expect(text).not.toContain('remote seats');
  });

  it('a custom note bypasses the routing-gate text entirely regardless of remoteSeats', () => {
    const text = deriveLaunchPromptText('custom kickoff', false, PLAN, 'full', SHARED_WITH_OFFERS);
    expect(text).toContain('custom kickoff');
    expect(text).not.toContain('placement');
  });
});
