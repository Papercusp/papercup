import { describe, expect, it } from 'vitest';

import { ACCEPTANCE_SNAPSHOT_CAP_CHARS, boundedSnapshotJson } from './acceptance-grader';

/**
 * EI-21615102901369580 — the frozen acceptance-evidence package used to jump straight
 * from "full" to a maximally-stripped shape, deleting audit citations, plan item text,
 * decision bodies and terminal-work evidence in one blanket step with NO marker. A judge
 * over the cap therefore received a package that looked complete, carried no evidence,
 * and could only stall. These tests pin the two properties that fix it: the package is
 * never silently degraded, and citations are the LAST thing surrendered.
 */

type Snapshot = Parameters<typeof boundedSnapshotJson>[0];

const pad = (n: number) => 'x'.repeat(n);

function makeSnapshot({
  items = 3,
  textChars = 60,
  citationsPerItem = 2,
}: { items?: number; textChars?: number; citationsPerItem?: number } = {}): Snapshot {
  return {
    frozenAt: '2026-08-27T00:00:00.000Z',
    plan: {
      slug: 'plan-under-test',
      workspaceId: 'ws',
      harnessSlug: 'h',
      version: 20,
      contentHash: 'abc123',
      items: Array.from({ length: items }, (_, i) => ({ id: `P-${i}`, status: 'done', text: pad(textChars) })),
      decisions: [{ id: 'D-001', title: 'a decision', body: pad(textChars) }],
    },
    rubric: {
      rubricId: 'rubric-1',
      title: 'acceptance rubric',
      proposedBy: 'su-impl',
      criteria: [{ key: 'c1', title: 'criterion one', description: pad(textChars) }],
    },
    audit: {
      auditSeq: 1,
      createdBy: 'su-impl',
      auditedSha: 'deadbeef',
      summary: pad(textChars),
      coverage: { verified: items },
      items: Array.from({ length: items }, (_, i) => ({
        itemId: `P-${i}`,
        verdict: 'verified',
        citations: Array.from({ length: citationsPerItem }, (_, c) => ({
          kind: 'code',
          path: `packages/operator-core/lib/file-${i}-${c}.ts`,
          line: 10 + c,
          symbol: `symbol${c}`,
        })),
      })),
    },
    terminalWork: [
      {
        id: 'WI-1',
        state: 'done',
        title: 'terminal work',
        terminalOwner: 'su-impl',
        completionRef: 'ref-1',
        evidence: pad(textChars),
      },
    ],
  } as unknown as Snapshot;
}

const parse = (snap: Snapshot) => JSON.parse(boundedSnapshotJson(snap));

describe('boundedSnapshotJson', () => {
  it('returns the package verbatim, and claims no degradation, when it already fits', () => {
    const snap = makeSnapshot({ items: 1, textChars: 10, citationsPerItem: 1 });
    const out = boundedSnapshotJson(snap);

    expect(out.length).toBeLessThanOrEqual(ACCEPTANCE_SNAPSHOT_CAP_CHARS);
    expect(out).toBe(JSON.stringify(snap));
    // A complete package must not carry a degradation marker, or the marker means nothing.
    expect(JSON.parse(out).contextIntegrity).toBeUndefined();
  });

  it('never truncates silently: it stamps contextIntegrity naming what it dropped', () => {
    const snapshot = makeSnapshot({ items: 40, textChars: 400, citationsPerItem: 4 });
    const rendered = boundedSnapshotJson(snapshot);
    const parsed = JSON.parse(rendered);

    expect(parsed.contextIntegrity?.degraded).toBe(true);
    expect(parsed.contextIntegrity.fullChars).toBeGreaterThan(ACCEPTANCE_SNAPSHOT_CAP_CHARS);
    expect(parsed.contextIntegrity.capChars).toBe(ACCEPTANCE_SNAPSHOT_CAP_CHARS);
    expect(parsed.contextIntegrity.droppedFields.length).toBeGreaterThan(0);
    // The judge must be told what to DO about the gap, not merely that one exists.
    expect(parsed.contextIntegrity.notice).toMatch(/NOT GRADED/);
    expect(parsed.contextIntegrity.recovery).toMatchObject({
      frozenIdentity: { planVersion: 20, planContentHash: 'abc123', auditSeq: 1 },
      reads: {
        plan: {
          tool: 'plans:get',
          args: { slug: 'plan-under-test', harness: 'h', mode: 'full', shipReadiness: true },
        },
        specEvidence: {
          tool: 'plans:get-spec-evidence',
          args: { slug: 'plan-under-test', harness: 'h', limit: 500 },
        },
        terminalWork: {
          tool: 'work_items:get',
          args: { harness: 'h', detail: true, threadLimit: 10 },
          idsFrom: 'terminalWork[].id',
        },
      },
    });
    expect(parsed.contextIntegrity.recovery.rule).toMatch(/Before NOT GRADED/);
    expect(rendered.length).toBeLessThanOrEqual(ACCEPTANCE_SNAPSHOT_CAP_CHARS);
  });

  it('keeps audit citations when the overflow can be absorbed elsewhere (the actual defect)', () => {
    // Overflow driven by prose (item text / decision body / terminal evidence), not by citations.
    const parsed = parse(makeSnapshot({ items: 3, textChars: 2000, citationsPerItem: 2 }));

    expect(parsed.contextIntegrity.degraded).toBe(true);
    // The old implementation deleted these unconditionally on any overflow.
    expect(parsed.audit.items[0].citations).toBeDefined();
    expect(parsed.audit.items[0].citations.length).toBeGreaterThan(0);
    expect(parsed.contextIntegrity.droppedFields.join(' ')).not.toMatch(/citations/);
  });

  it('surrenders citations only as the LAST resort, and says so when it does', () => {
    // Citations themselves dominate here, so no amount of prose-trimming can save them.
    const parsed = parse(makeSnapshot({ items: 300, textChars: 40, citationsPerItem: 6 }));
    const droppedFields: string[] = parsed.contextIntegrity.droppedFields;

    expect(parsed.audit.items[0].citations).toBeUndefined();
    // Ordering IS the fix: citations must be the final concession, never an early one.
    expect(droppedFields[droppedFields.length - 1]).toMatch(/citations/);
    expect(droppedFields[droppedFields.length - 1]).toMatch(/LAST RESORT/);
    expect(droppedFields.length).toBeGreaterThan(1);
  });

  it('gives back as much as fits: a smaller overflow drops strictly fewer fields', () => {
    const small = parse(makeSnapshot({ items: 3, textChars: 2000, citationsPerItem: 2 }));
    const large = parse(makeSnapshot({ items: 300, textChars: 400, citationsPerItem: 6 }));

    expect(small.contextIntegrity.droppedFields.length).toBeLessThan(large.contextIntegrity.droppedFields.length);
  });
});

/**
 * The pre-fix implementation, kept permanently as a control. A guard test that has
 * never failed is a guard nobody has tested, and the repo forbids proving that by
 * mutating the shared tree — so the defective version lives here, in-file, and the
 * assertions below show these guards actually CATCH it rather than merely passing.
 */
function legacyBoundedSnapshotJson(snapshot: Snapshot): string {
  const full = JSON.stringify(snapshot);
  if (full.length <= ACCEPTANCE_SNAPSHOT_CAP_CHARS) return full;
  return JSON.stringify({
    ...snapshot,
    plan: {
      ...snapshot.plan,
      items: snapshot.plan.items.map(({ id, status }) => ({ id, status })),
      decisions: snapshot.plan.decisions.map(({ id, title }) => ({ id, title })),
    },
    audit: { ...snapshot.audit, items: snapshot.audit.items.map(({ itemId, verdict }) => ({ itemId, verdict })) },
    terminalWork: snapshot.terminalWork.map(({ id, state, completionRef }) => ({ id, state, completionRef })),
  });
}

describe('CONTROL: the pre-fix implementation fails these same guards', () => {
  // A modest overflow: absorbable by trimming prose, so citations never needed to go.
  const snap = makeSnapshot({ items: 3, textChars: 2000, citationsPerItem: 2 });

  it('CONTROL: legacy deletes audit citations on any overflow — the defect itself', () => {
    expect(JSON.parse(legacyBoundedSnapshotJson(snap)).audit.items[0].citations).toBeUndefined();
  });

  it('CONTROL: legacy truncates with no marker, so the judge cannot know', () => {
    expect(JSON.parse(legacyBoundedSnapshotJson(snap)).contextIntegrity).toBeUndefined();
  });

  it('CALIBRATION: the real implementation passes exactly where legacy fails', () => {
    const fixed = JSON.parse(boundedSnapshotJson(snap));
    expect(fixed.audit.items[0].citations.length).toBeGreaterThan(0);
    expect(fixed.contextIntegrity.degraded).toBe(true);
  });
});
