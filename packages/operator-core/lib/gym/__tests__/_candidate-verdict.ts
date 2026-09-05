/**
 * Shared candidate-version verdict fixture (P-002 / D-004(3)).
 *
 * Exists because the promotion gate made an ABSENT verdict a refusal, which is correct
 * in production and awkward in a fixture: several integration tests are about the accept
 * WRITE (does the prompt land, does the ledger row appear, does a nested transaction
 * work) and had no reason to carry a verdict at all. Rather than let each one reach for
 * the override — which would quietly stop them exercising the path production takes —
 * they carry a minimal PASSING verdict from here.
 *
 * Deliberately minimal: it satisfies `realAnchorHeld`, not `isPromotableCandidate`. The
 * auto-promote path has its own stricter fixtures (hash-pinned, in
 * gym/control-plane.integration.test.ts) and conflating the two would let a test that
 * only needs "the gate holds" start silently depending on hash plumbing.
 */
import { REAL_ANCHOR_GATE } from '../promotion-gate';
import type { CandidateVersionVerdict } from '../loop';

/** A verdict whose real-anchor gate affirmatively PASSES — the install-permitting case. */
export function passingCandidateVerdict(candidateId = 'cand-fixture'): CandidateVersionVerdict {
  return {
    schemaVersion: 1,
    candidateId,
    parentId: 'baseline',
    variant: { promptOverrides: {} } as CandidateVersionVerdict['variant'],
    parent: { promptOverrides: {} } as CandidateVersionVerdict['parent'],
    hashes: { variantHash: 'variant', parentHash: 'parent', evaluatorHash: 'evaluator', rubricHash: 'rubric', taskHash: 'task', codeHash: 'code' },
    gateResults: [{ gate: REAL_ANCHOR_GATE, pass: true, status: 'pass', detail: 'fixture: real-anchor held' }],
    verdict: 'accept',
    recordedAt: 0,
  };
}
