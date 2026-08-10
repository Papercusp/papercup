import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import { buildDocPartRows, checkSnapshotAgreement, EVIDENCE_SUFFIX, ruleAndEvidence } from '../../../../scripts/load-claude-md-doc-parts.mjs';
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import { buildRuleEvidence } from '../../../../scripts/split-claude-md-rule-evidence.mjs';
// @ts-expect-error — .mjs script, no type declarations by design (it is a scripts/ tool).
import { extractParts } from '../../../../scripts/gen-claude-md-manifest.mjs';
import { createHash } from 'node:crypto';

/**
 * P-003 — loading CLAUDE.md into `harness_doc_parts`.
 *
 * ⚠ NOTHING HERE TOUCHES THE LIVE CLAUDE.md OR A DATABASE, deliberately, and both
 * halves of that matter. The file changes several times an hour on this fleet, so a
 * fixture asserting against it is red before the day is out; and the row builder is
 * a pure function precisely so the interesting decisions can be tested without one.
 *
 * The manifest and rule/evidence inputs are DERIVED from the synthetic text by the
 * real generators rather than hand-written, so a change to how a partKey is computed
 * cannot silently desynchronise the fixture from the code under test.
 */
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Build the two artifacts the loader consumes, for an arbitrary synthetic doc. */
function artifactsFor(text: string, classify: (raw: string) => Record<string, unknown>) {
  const parts = extractParts(text);
  const ruleEvidence = buildRuleEvidence(text, {});
  const manifest = {
    docId: 'synthetic',
    contentMode: 'composed',
    snapshotSha256: sha256(text),
    parts: parts.map((p: { partKey: string; ordinal: number; blockSha: string; raw: string }) => ({
      partKey: p.partKey,
      ordinal: p.ordinal,
      blockSha: p.blockSha,
      ...classify(p.raw),
    })),
  };
  return { manifest, ruleEvidence };
}

const RULE = 'Never route around a blocked lock, because that lock is a peer in-flight edit. ';
const EV = 'Measured 2026-08-02: an agent renamed the file and stranded the peer edit (WI-7101).';
const PROSE = 'A long-form narrative block that belongs in the corpus rather than in any client file.';

const DOC = ['# Doc', '', RULE + EV, '', PROSE, ''].join('\n');
// Classified by CONTENT, not position: the doc's heading is itself a block, so an
// index-based fixture silently labels the wrong one (it did, on the first run).
const CLASSIFY = (raw: string) =>
  raw.startsWith('Never route around')
    ? { kind: 'invariant', clientScope: ['all'], targetSection: 'Locks', projectRank: 100 }
    : { kind: 'prose', clientScope: [], targetSection: null, projectRank: 900 };

describe('buildDocPartRows — the rule projects, the evidence does not follow it', () => {
  const { manifest, ruleEvidence } = artifactsFor(DOC, CLASSIFY);
  const { rows, problems, summary } = buildDocPartRows(DOC, manifest, ruleEvidence);

  it('splits a projected block into a projecting rule and a corpus-only evidence row', () => {
    expect(problems).toEqual([]);
    const rule = rows.find((r: { kind: string }) => r.kind === 'invariant');
    const evidence = rows.find((r: { part_key: string }) => r.part_key.endsWith(EVIDENCE_SUFFIX));
    expect(rule.body).toBe(RULE);
    expect(rule.client_scope).toEqual(['all']);
    expect(evidence.body).toBe(EV);
    // The whole point: the observation is reachable in the corpus but cannot reach a client file.
    expect(evidence.kind).toBe('prose');
    expect(evidence.client_scope).toEqual([]);
  });

  it('keeps a corpus prose block WHOLE rather than fragmenting it', () => {
    const proseBodies = rows
      .filter((r: { part_key: string; kind: string }) => r.kind === 'prose' && !r.part_key.endsWith(EVIDENCE_SUFFIX))
      .map((r: { body: string }) => r.body);
    expect(proseBodies).toContain(PROSE);
    expect(rows.every((r: { kind: string; client_scope: string[] }) => r.kind !== 'prose' || r.client_scope.length === 0)).toBe(true);
  });

  it('emits at least one row for every block — nothing is dropped on the floor', () => {
    const covered = new Set(rows.map((r: { part_key: string }) => r.part_key.replace(EVIDENCE_SUFFIX, '')));
    for (const p of manifest.parts) expect(covered.has(p.partKey)).toBe(true);
    expect(summary.blocks).toBe(manifest.parts.length);
  });

  // The property the byte-offset design exists to give: for every non-authored block
  // the two bodies are exact slices, so no character is invented or lost in transit.
  it('reconstructs a split block EXACTLY from its two rows', () => {
    const idx = extractParts(DOC).findIndex((p: { raw: string }) => p.raw.startsWith('Never route around'));
    const raw = extractParts(DOC)[idx].raw;
    const pair = ruleEvidence.pairs[idx];
    expect(pair.mode).toBe('split');
    const { rule, evidence, exact } = ruleAndEvidence(raw, pair);
    expect(exact).toBe(true);
    expect(rule + evidence).toBe(raw);
  });
});

describe('buildDocPartRows — CONTROLS that must FAIL', () => {
  it('CONTROL — prose that claims a client scope is rejected before it reaches the DB CHECK', () => {
    const { manifest, ruleEvidence } = artifactsFor(DOC, () => ({
      kind: 'prose',
      clientScope: ['all'],
      targetSection: 'Somewhere',
      projectRank: 100,
    }));
    const { problems } = buildDocPartRows(DOC, manifest, ruleEvidence);
    expect(problems.some((p: string) => /prose must not project/.test(p))).toBe(true);
  });

  it('CONTROL — a projected part with no target_section is rejected', () => {
    const { manifest, ruleEvidence } = artifactsFor(DOC, () => ({
      kind: 'invariant',
      clientScope: ['all'],
      targetSection: null,
      projectRank: 100,
    }));
    const { problems } = buildDocPartRows(DOC, manifest, ruleEvidence);
    expect(problems.some((p: string) => /no target_section/.test(p))).toBe(true);
  });

  // The failure the sha guard exists to prevent: the manifest classifies BY partKey,
  // so against drifted text a stale entry would attach its kind/scope to different
  // prose — and every resulting row would still satisfy every constraint.
  it('CONTROL — a block whose content changed under a stale manifest entry is refused, not loaded', () => {
    const { manifest, ruleEvidence } = artifactsFor(DOC, CLASSIFY);
    manifest.parts[0].blockSha = 'deadbeefdeadbeef';
    const { rows, problems } = buildDocPartRows(DOC, manifest, ruleEvidence);
    expect(problems.some((p: string) => /blockSha disagrees/.test(p))).toBe(true);
    expect(rows.some((r: { part_key: string }) => r.part_key === manifest.parts[0].partKey)).toBe(false);
  });

  it('CONTROL — a manifest naming a block that no longer exists is reported', () => {
    const { manifest, ruleEvidence } = artifactsFor(DOC, CLASSIFY);
    manifest.parts.push({ partKey: 'ghost-block', ordinal: 99, blockSha: 'x', kind: 'invariant', clientScope: ['all'], targetSection: 'S', projectRank: 1 });
    const { problems } = buildDocPartRows(DOC, manifest, ruleEvidence);
    expect(problems.some((p: string) => /does not exist in the source text/.test(p))).toBe(true);
  });
});

describe('checkSnapshotAgreement — refuses to load against drifted text', () => {
  it('CALIBRATION — agrees when both artifacts describe the live text', () => {
    const { manifest, ruleEvidence } = artifactsFor(DOC, CLASSIFY);
    expect(checkSnapshotAgreement(DOC, manifest, ruleEvidence).agreed).toBe(true);
  });

  it('CONTROL — a peer edit between generation and load is caught', () => {
    const { manifest, ruleEvidence } = artifactsFor(DOC, CLASSIFY);
    const edited = `${DOC}\nA peer appended this paragraph after the artifacts were generated.\n`;
    const verdict = checkSnapshotAgreement(edited, manifest, ruleEvidence);
    expect(verdict.agreed).toBe(false);
    expect(verdict.disagree.length).toBe(2);
  });
});
