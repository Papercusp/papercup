/** P004: the final transport must not credit a partial action as delivered. */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';

const subject: typeof import('./leader-brief-shape') = process.env.PAPERCUSP_LEADER_BRIEF_PROBE
  ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_LEADER_BRIEF_PROBE).href)
  : await import('./leader-brief-shape');

function render(text: string) {
  return subject.shapeLeaderBrief({ ok: true, summary: { fleet: 'goal-plan-fleet' }, agentObligations: {
    schemaVersion: 'agent-obligations-v1', sourceGeneration: 'agenda-source',
    primary: [{ id: 'obl:goal-plan-placement:fixture', family: 'plan-placement', status: 'due',
      sourceGeneration: 'placement-source', ruleRevision: 'goal-plan-placement-v3',
      action: { kind: 'delegate', summary: 'Launch the independently led plan fleet', recoveryRef: 'coord:orient' } }],
    detailRef: 'fleet:leader-brief { payloadTier:"full" }',
    projection: { text, receipt: { entriesAvailable: 1, entriesDelivered: 1, entriesOmitted: 0,
      bodyDeliveredChars: text.length, estimatedTokens: Math.ceil(text.length / 4), bodyTruncated: false, refused: false } },
  } }, 'trimmed') as { agentObligations: {
    primary: Array<{ id: string; sourceGeneration: string; ruleRevision: string; action: { recoveryRef: string } }>;
    projection: { text: string; receipt: { entriesDelivered: number; entriesOmitted: number; bodyTruncated: boolean } };
  } };
}

describe('goal obligation delivery receipt intent', () => {
  it('keeps the exact obligation and source revision in the shared leader surface', () => {
    expect(render('Launch the plan fleet').agentObligations.primary[0]).toMatchObject({
      id: 'obl:goal-plan-placement:fixture', sourceGeneration: 'placement-source',
      ruleRevision: 'goal-plan-placement-v3', action: { recoveryRef: 'coord:orient' },
    });
  });
  it('credits the whole action when it fits', () => {
    const out = render('Launch the independently led plan fleet');
    expect(out.agentObligations.projection.text).toBe('Launch the independently led plan fleet');
    expect(out.agentObligations.projection.receipt).toMatchObject({ entriesDelivered: 1, entriesOmitted: 0, bodyTruncated: false });
  });
  it('never credits an action discarded by the final character cap', () => {
    const out = render('Launch the independently led plan fleet ' + 'x'.repeat(900));
    expect(out.agentObligations.projection.text).toBe('');
    expect(out.agentObligations.projection.receipt.entriesDelivered,
      'A discarded action must not retain its inner delivered count').toBe(0);
    expect(out.agentObligations.projection.receipt).toMatchObject({ entriesOmitted: 1, bodyTruncated: true });
  });
});
