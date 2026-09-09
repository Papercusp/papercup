import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { PlanRow } from '../agent-tools/plans/source';
import type { DreamRun } from './dream-run-store';
import { buildCapabilityReviewSources, type CapabilityReviewSourceDeps } from './capability-review-sources';
import { getPilotCapabilityManifest } from './capability-catalog';
import { capabilityHash, capabilityUnitHash, type CapabilityPacket } from './capability-contracts';
import { type CapabilityProposal } from './capability-pass';
import { verifyCapabilityPacket } from './capability-packets';
import { capabilityContentVersion, capabilityPairKey, type CapabilitySelection } from './capability-sampler';
import {
  CAPABILITY_PRIOR_KINDS,
  capabilityProposalHash,
  capabilityReviewEvidenceHash,
  capabilityReviewQueries,
  runCapabilityDreamReview,
  type CapabilityReviewControl,
  type CapabilityReviewDeps,
  type CapabilityReviewJudgment,
  type CapabilityReviewPrior,
  type CapabilityReviewSearch,
  type CapabilityReviewSources,
  type RunCapabilityReviewOptions,
} from './capability-review';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const textA = 'export function snapshot() { return scopedState; }';
const textB = 'export function evaluate(state) { return replayFailure(state); }';
const scope = { workspaceId: 'ws', potSlug: 'pot', repositoryId: 'repo' };
const citation = (unit: 'A' | 'B') => ({ unit, evidenceId: 'code' });
const quote = (unit: 'A' | 'B') => ({ ref: unit + ':code', quote: unit === 'A' ? textA : textB });
function candidate(): CapabilityProposal {
  return {
    beneficiary: 'Engineers debugging intermittent failures.',
    behavior: 'Replay the failure evaluation with a restored state snapshot.',
    observed: [
      { claim: 'A returns scoped state.', sources: [citation('A')] },
      { claim: 'B evaluates state for failure reproduction.', sources: [citation('B')] },
    ],
    hypothesis: 'Restoring scoped state can improve failure reproduction.',
    primaryContributions: {
      A: {
        uniqueContribution: 'Captures scoped state.',
        removalEffect: 'No controlled initial state.',
        sources: [citation('A')],
      },
      B: {
        uniqueContribution: 'Evaluates failure reproduction.',
        removalEffect: 'No failure outcome.',
        sources: [citation('B')],
      },
    },
    thirdContribution: null,
    relations: [
      {
        kind: 'producer-consumer',
        from: citation('A'),
        to: citation('B'),
        mapping: 'Scoped state from A supplies the input of B.',
        preconditions: ['The snapshot covers the tested inputs.'],
        transferRisks: ['External services may retain uncaptured state.'],
      },
    ],
    assumptions: ['The snapshot covers the evaluated dependency.'],
    missingEvidence: ['The combined experiment is not run yet.'],
    priorArt: {
      knownRelatedWork: [],
      proposedDelta: 'Restore captured state rather than only per-test setup.',
      verification: 'unverified',
    },
    experiment: {
      baseline: 'Current per-test setup.',
      change: 'Restore a scoped snapshot before evaluation.',
      measurement: 'Count reproduced failures over the same cases.',
      successCriterion: 'Reproduce more known failures at the same cost.',
      falsifier: 'No additional failures reproduced or the cost ceiling is exceeded.',
    },
  };
}
function prior(ref = 'plan:existing', kind: CapabilityReviewPrior['kind'] = 'plan'): CapabilityReviewPrior {
  const text = 'Existing per-test setup initializes inputs but does not restore prior failing state.';
  return {
    ref,
    kind,
    scope,
    text,
    contentHash: capabilityHash(text),
    sourceHash: capabilityHash(text),
    candidateHash: null,
    evidenceHash: null,
  };
}
function judgment(priors: CapabilityReviewPrior[]): CapabilityReviewJudgment {
  const supported = (unit: 'A' | 'B') => ({
    status: 'supported' as const,
    note: 'Supported by the cited implementation.',
    evidence: [quote(unit)],
  });
  return {
    verdict: 'accept',
    note: 'A scoped restoration experiment adds a behavioral delta to the cited setup.',
    observations: [
      { index: 0, ...supported('A') },
      { index: 1, ...supported('B') },
    ],
    comparisons: priors.map((p) => ({
      ref: p.ref,
      disposition: 'distinct',
      note: 'The existing setup lacks restoration.',
      evidence: [{ ref: 'prior:' + p.ref, quote: p.text.slice(0, 300) }],
    })),
    relation: { ...supported('A'), evidence: [quote('A'), quote('B')] },
    feasibility: supported('B'),
    experiment: {
      executable: true,
      probe: 'Run evaluate(snapshot()) over the fixed failure cases.',
      baseline: 'Run evaluate with current test setup.',
      falsifier: 'Reproduction rate does not increase within the fixed cost.',
      evidence: [{ ref: 'B:test', quote: 'expect(evaluate(state)).toEqual(failure);' }],
    },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'capability-review-'));
  roots.push(root);
  await mkdir(join(root, 'fixtures'));
  await writeFile(join(root, 'pack.xml'), 'source pack');
  async function packet(label: 'A' | 'B'): Promise<CapabilityPacket> {
    const unit = structuredClone(getPilotCapabilityManifest().units[0]!);
    unit.id = 'capability:' + label;
    unit.granularity = 'capability';
    unit.branch = label;
    unit.parentId = null;
    unit.relatedUnitIds = [];
    unit.overlapsUnitIds = [];
    unit.evidence = [
      {
        id: 'code',
        kind: 'implementation',
        path: 'fixtures/' + label + '.ts',
        anchor: label === 'A' ? 'function snapshot' : 'function evaluate',
        proves: 'Current implementation.',
      },
      {
        id: 'test',
        kind: 'test',
        path: 'fixtures/' + label + '.test.ts',
        anchor: label === 'A' ? 'expect(snapshot())' : 'expect(evaluate(state))',
        proves: 'Executable contract.',
      },
    ];
    unit.purpose = [
      {
        text: label === 'A' ? 'Capture scoped state.' : 'Reproduce evaluation failures.',
        status: 'observed',
        evidenceIds: ['code'],
      },
    ];
    unit.mechanism = [
      {
        text: label === 'A' ? 'State snapshot extraction.' : 'State-dependent evaluation replay.',
        status: 'observed',
        evidenceIds: ['code'],
      },
    ];
    unit.evaluation = [{ text: 'Contract assertions on outputs.', status: 'observed', evidenceIds: ['test'] }];
    for (const key of Object.keys(unit.contracts) as Array<keyof typeof unit.contracts>) unit.contracts[key] = [];
    const sources = await Promise.all(
      unit.evidence.map(async (e) => {
        const excerpt =
          e.kind === 'implementation'
            ? label === 'A'
              ? textA
              : textB
            : label === 'A'
              ? 'expect(snapshot()).toEqual(scopedState);'
              : 'expect(evaluate(state)).toEqual(failure);';
        await writeFile(join(root, e.path), excerpt);
        return {
          ...e,
          excerpt,
          sourceHash: capabilityHash(excerpt),
          excerptHash: capabilityHash(excerpt),
          startLine: 1,
          endLine: 1,
        };
      }),
    );
    return {
      schemaVersion: 'dream-capability-packet-v1',
      scope,
      unit,
      unitHash: capabilityUnitHash(unit),
      manifestRevision: 'review-fixture-v1',
      sources,
      extraction: {
        recipeVersion: 'scanned-anchors-and-radius-v2',
        promptVersion: 'manifest-facets-v1',
        capturedAt: '2026-09-07T14:00:00Z',
        sourceCommit: null,
        dirty: true,
        backend: 'text',
        indexHealth: 'unknown',
        artifactRef: join(root, 'pack.xml'),
        artifactHash: capabilityHash('source pack'),
        durationMs: 0,
        securityScan: 'passed',
        costUsd: 0,
      },
      coverage: {
        status: 'partial',
        includedPaths: sources.map((s) => s.path),
        excluded: [],
        unresolved: [],
        truncated: false,
        note: 'Controlled fixture sources; no global coverage claim.',
      },
    };
  }
  const [aPacket, bPacket] = await Promise.all([packet('A'), packet('B')]);
  const a = { packet: aPacket, contentVersion: capabilityContentVersion(aPacket) };
  const b = { packet: bPacket, contentVersion: capabilityContentVersion(bPacket) };
  const selection: CapabilitySelection = {
    a,
    b,
    c: null,
    pairKey: capabilityPairKey(a, b),
    attemptKey: 'a'.repeat(64),
    recipe: 'capability-capability',
    relation: null,
  };
  const manifest = {
    ...getPilotCapabilityManifest(),
    revision: 'review-fixture-v1',
    units: [aPacket.unit, bPacket.unit],
  };
  const priors = [prior()];
  const queries: CapabilityReviewSearch[] = [];
  const sources: CapabilityReviewSources = {
    search: vi.fn(async (input) => {
      queries.push(input);
      return {
        scope,
        kinds: CAPABILITY_PRIOR_KINDS,
        status: 'current' as const,
        matches: priors,
        truncated: false,
        note: 'Fixture corpus, including rejected history.',
      };
    }),
    readCurrent: vi.fn(async (p) => priors.find((current) => current.ref === p.ref) ?? null),
  };
  let final: unknown = judgment(priors);
  const controlA: CapabilityReviewControl = {
    unchanged: false,
    note: 'A cannot evaluate failures.',
    evidence: [quote('A')],
  };
  const controlB: CapabilityReviewControl = {
    unchanged: false,
    note: 'B cannot restore state.',
    evidence: [quote('B')],
  };
  const calls: Parameters<RunCapabilityReviewOptions['llmCall']>[0][] = [];
  const options: RunCapabilityReviewOptions = {
    candidate: candidate(),
    selection,
    rootPath: root,
    manifest,
    sources,
    dreamerModel: 'generator-model',
    config: { model: 'reviewer-model' },
    llmCall: async (input) => {
      calls.push(input);
      input.onAdmitted?.();
      input.onResponseStart?.();
      const prompt = JSON.parse(input.messages[0]!.content as string);
      const value = prompt.retained ? (prompt.retained.label === 'A' ? controlA : controlB) : final;
      return { text: '', json: structuredClone(value), costUsd: 0.01, inputTokens: 100, outputTokens: 80 };
    },
  };
  const deps: CapabilityReviewDeps = {
    verifyPacket: (value, input) =>
      verifyCapabilityPacket(value, input, { readArtifact: (path) => readFile(path, 'utf8') }),
    rerank: vi.fn(async (_q, values) => ({
      priors: values.slice().reverse().slice(0, 8),
      outcome: { attempted: true, scored: values.length },
    })),
  };
  return {
    root,
    options,
    deps,
    priors,
    queries,
    sources,
    calls,
    controlA,
    controlB,
    setJudgment: (value: unknown) => {
      final = value;
    },
  };
}

describe('independent capability source and skeptical review', () => {
  it('publishes the enforced response schema to both controls and final adjudication', async () => {
    const f = await fixture();
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.verdict).toBe('accept');
    expect(f.calls).toHaveLength(3);
    for (const input of f.calls) {
      const prompt = JSON.parse(input.messages[0]!.content as string);
      expect(prompt.responseSchema.additionalProperties).toBe(false);
      expect(prompt.responseSchema.properties.note.maxLength).toBe(600);
      expect(prompt.responseSchema.required).toContain('note');
    }
    const final = JSON.parse(f.calls[2]!.messages[0]!.content as string);
    expect(final.responseSchema.properties.comparisons.maxItems).toBe(8);
  });

  it('preserves invalid paid control results without clipping or retrying overlong notes', async () => {
    const f = await fixture();
    f.controlA.note = 'x'.repeat(601);
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.reason).toBe('review-unavailable');
    expect(result.verdict).toBe('unverified');
    expect(f.calls).toHaveLength(2);
    expect(result.usage.costUsd).toBe(0.02);
  });

  it.each(['missing-ref', 'quote-not-found'] as const)(
    'retains the invalid judgment and exact %s evidence without admitting it',
    async (reason) => {
      const f = await fixture();
      const review = judgment(f.priors);
      if (reason === 'missing-ref') review.feasibility.evidence[0]!.ref = 'B:missing';
      else review.feasibility.evidence[0]!.quote = 'imaginary source text';
      f.setJudgment(review);
      const result = await runCapabilityDreamReview(f.options, f.deps);
      expect(result).toMatchObject({ verdict: 'unverified', reason: 'review-unavailable', judgment: null });
      const failure = result.failures!.review!;
      expect(failure.stage).toBe('grounding');
      expect(failure.invalidEvidence).toEqual({
        total: 1,
        entries: [{ path: 'feasibility.evidence[0]', ...review.feasibility.evidence[0], reason }],
      });
      expect(failure.response).toMatchObject({
        chars: JSON.stringify(review).length,
        sha256: capabilityHash(JSON.stringify(review)),
        truncated: false,
      });
      expect(JSON.parse(failure.response!.preview)).toEqual(review);
      // The diagnostic survives the same JSON serialization used by the run ledger.
      expect(JSON.parse(JSON.stringify(result)).failures.review).toEqual(failure);
      expect(result.usage.costUsd).toBe(0.03);
      expect(f.calls).toHaveLength(3);
    },
  );

  it('retains both invalid controls, schema paths, and the offending withheld-unit citation', async () => {
    const f = await fixture();
    f.controlA.note = 'x'.repeat(601);
    f.controlB.evidence[0]!.ref = 'A:code';
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'unverified', controls: { aOnly: null, bOnly: null }, judgment: null });
    expect(result.failures!['control-a']).toMatchObject({
      stage: 'schema',
      issues: [{ path: 'note', code: 'too_big' }],
    });
    expect(result.failures!['control-b']).toMatchObject({
      stage: 'grounding',
      invalidEvidence: { total: 1, entries: [{ ref: 'A:code', reason: 'missing-ref' }] },
    });
    expect(result.usage.costUsd).toBe(0.02);
    expect(f.calls).toHaveLength(2);
  });

  it.each(['malformed', 'oversized'] as const)(
    'bounds %s response diagnostics and retains their identity',
    async (mode) => {
      const f = await fixture();
      const original = f.options.llmCall;
      const raw = mode === 'malformed' ? '{"verdict":' : 'x'.repeat(32_001);
      f.options.llmCall = async (input) => {
        const response = await original(input);
        return f.calls.length === 3 ? { ...response, json: undefined, text: raw } : response;
      };
      const result = await runCapabilityDreamReview(f.options, f.deps);
      expect(result).toMatchObject({ verdict: 'unverified', judgment: null });
      expect(result.failures!.review).toMatchObject({
        stage: 'response',
        response: {
          preview: raw.slice(0, 6_000),
          chars: raw.length,
          sha256: capabilityHash(raw),
          truncated: raw.length > 6_000,
        },
      });
      expect(result.usage.costUsd).toBe(0.03);
      expect(f.calls).toHaveLength(3);
    },
  );

  it('retains structurally valid but incomplete adjudication separately from trusted judgment', async () => {
    const f = await fixture();
    const review = judgment(f.priors);
    review.observations.pop();
    f.setJudgment(review);
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'unverified', judgment: null });
    expect(result.failures!.review!.stage).toBe('coverage');
    expect(JSON.parse(result.failures!.review!.response!.preview)).toEqual(review);
  });

  it('does not attach failure diagnostics to a valid accepted review', async () => {
    const f = await fixture();
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.verdict).toBe('accept');
    expect(result.judgment).not.toBeNull();
    expect(result.failures).toBeUndefined();
  });

  it('bounds diagnostic samples without hiding their total or silently truncating the adjudication', async () => {
    const f = await fixture();
    const review = judgment(f.priors);
    review.observations = Array.from({ length: 12 }, (_, index) => ({
      index,
      status: 'supported',
      note: 'Observed claim ' + index,
      evidence: [{ ref: 'A:missing-' + index, quote: 'x'.repeat(600) }],
    }));
    f.setJudgment(review);
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'unverified', judgment: null });
    expect(result.failures!.review!.invalidEvidence!.total).toBe(12);
    expect(result.failures!.review!.invalidEvidence!.entries).toHaveLength(8);
    expect(result.failures!.review!.response).toMatchObject({
      preview: JSON.stringify(review).slice(0, 6_000),
      chars: JSON.stringify(review).length,
      sha256: capabilityHash(JSON.stringify(review)),
      truncated: true,
    });
    expect(f.calls).toHaveLength(3);
  });

  it('retains bounded schema diagnostics for the final judgment, not only controls', async () => {
    const f = await fixture();
    const review = judgment(f.priors);
    review.observations = Array.from({ length: 12 }, (_, index) => ({
      index,
      status: 'supported',
      note: 'x'.repeat(601),
      evidence: [quote('A')],
    }));
    f.setJudgment(review);
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'unverified', judgment: null });
    expect(result.failures!.review).toMatchObject({
      stage: 'schema',
      issueCount: 12,
    });
    expect(result.failures!.review!.issues![0]).toMatchObject({ path: 'observations.0.note', code: 'too_big' });
    expect(result.failures!.review!.issues).toHaveLength(8);
    expect(f.calls).toHaveLength(3);
  });

  it('checks actual files, retrieves all facets, preserves scopes and uses three isolated different-model contexts', async () => {
    const f = await fixture();
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.verdict, result.note).toBe('accept');
    expect(result.coverage.globalNovelty).toBe('not-established');
    expect(f.queries.map((q) => q.facet)).toEqual(['purpose', 'mechanism', 'evaluation']);
    for (const q of f.queries) {
      expect(q.scope).toEqual(scope);
      expect(q.kinds).toEqual(CAPABILITY_PRIOR_KINDS);
      expect(q.query).toContain(f.options.candidate.behavior);
    }
    expect(capabilityReviewQueries(f.options.candidate, f.options.selection)[1]!.query).toContain(
      'State-dependent evaluation replay.',
    );
    expect(f.calls).toHaveLength(3);
    expect(f.calls.map((call) => call.maxTokens)).toEqual([1_024, 1_024, 4_096]);
    const aOnly = JSON.parse(f.calls[0]!.messages[0]!.content as string);
    const bOnly = JSON.parse(f.calls[1]!.messages[0]!.content as string);
    expect(aOnly.retained.label).toBe('A');
    expect(JSON.stringify(aOnly)).not.toContain(textB);
    expect(bOnly.retained.label).toBe('B');
    expect(JSON.stringify(bOnly)).not.toContain(textA);
    for (const call of f.calls) {
      expect(call.model).toBe('reviewer-model');
      expect(call.messages).toHaveLength(1);
    }
    expect(result.usage).toMatchObject({ costUsd: 0.03, inputTokens: 300, outputTokens: 240 });
    expect(f.sources.readCurrent).toHaveBeenCalledTimes(2);
  });
  it.each(['A', 'B'] as const)(
    'rejects a candidate unchanged with only primary %s, retaining its evidence',
    async (label) => {
      const f = await fixture();
      (label === 'A' ? f.controlA : f.controlB).unchanged = true;
      f.options.candidate.behavior =
        label === 'A' ? 'Capture scoped state.' : 'Evaluate a known failure from input state.';
      (label === 'A' ? f.controlA : f.controlB).note =
        'The retained implementation already supplies this target behavior.';
      const result = await runCapabilityDreamReview(f.options, f.deps);
      expect(result).toMatchObject({ verdict: 'reject', reason: 'one-unit-only' });
      expect(result.controls[label === 'A' ? 'aOnly' : 'bOnly']!.evidence).toEqual([quote(label)]);
      expect(f.calls).toHaveLength(2);
    },
  );
  it('keeps an inconclusive removal comparison separate from a disproven candidate', async () => {
    const f = await fixture();
    f.controlB.unchanged = null;
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'unverified',
      reason: 'counterfactual-unknown',
    });
  });
  it.each(['changed', 'missing', 'changed-test'] as const)(
    'refuses %s disk evidence before paid review',
    async (mode) => {
      const f = await fixture();
      const path = join(f.root, mode === 'changed-test' ? 'fixtures/B.test.ts' : 'fixtures/A.ts');
      if (mode === 'missing') await rm(path);
      else await writeFile(path, 'changed source');
      const result = await runCapabilityDreamReview(f.options, f.deps);
      expect(result).toMatchObject({ verdict: 'unverified', reason: 'source-unavailable' });
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each(['stale', 'unknown', 'unavailable'] as const)(
    'records %s retrieval coverage without claiming originality',
    async (status) => {
      const f = await fixture();
      f.sources.search = vi.fn(async () => ({
        scope,
        kinds: CAPABILITY_PRIOR_KINDS,
        status,
        matches: [],
        truncated: false,
        note: 'Index is unhealthy.',
      }));
      const result = await runCapabilityDreamReview(f.options, f.deps);
      expect(result.verdict).toBe('unverified');
      expect(result.coverage.globalNovelty).toBe('not-established');
      expect(result.coverage.searches.length).toBeGreaterThan(0);
      expect(f.calls).toHaveLength(0);
    },
  );
  it('does not certify novelty from an empty but successful search', async () => {
    const f = await fixture();
    f.priors.splice(0);
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'unverified',
      reason: 'empty-search',
    });
    expect(f.calls).toHaveLength(0);
  });
  it('retains every attempted facet and the source failure in its coverage record', async () => {
    const f = await fixture();
    f.sources.search = async () => {
      throw new Error('history backend unavailable');
    };
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.verdict).toBe('unverified');
    expect(result.coverage.searches.map((s) => s.facet)).toEqual(['purpose', 'mechanism', 'evaluation']);
    expect(
      result.coverage.searches.every((s) => s.status === 'unavailable' && s.note === 'history backend unavailable'),
    ).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
  it.each(['missing', 'stale'] as const)('refuses %s supporting prior sources', async (mode) => {
    const f = await fixture();
    f.sources.readCurrent = vi.fn(async (p) => (mode === 'missing' ? null : { ...p, text: p.text + ' changed' }));
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'unverified',
      reason: 'search-unavailable',
    });
    expect(f.calls).toHaveLength(0);
  });
  it('rejects a renamed existing integration by cited behavior, not a similarity cutoff', async () => {
    const f = await fixture();
    const priorText = 'hydrateFixture restores recorded state, then replayCase evaluates the captured failure.';
    Object.assign(f.priors[0]!, {
      kind: 'implementation',
      text: priorText,
      contentHash: capabilityHash(priorText),
      sourceHash: capabilityHash(priorText),
    });
    const review = judgment(f.priors);
    review.comparisons[0]!.disposition = 'duplicate';
    review.comparisons[0]!.note =
      'hydrateFixture/replayCase already restore and replay; the new names add no behavior.';
    f.setJudgment(review);
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'reject', reason: 'duplicate', note: review.comparisons[0]!.note });
    expect(result.judgment!.comparisons[0]!.evidence[0]!.quote).toBe(priorText);
  });
  it('allows a related but distinct delta even with a low legacy duplicate similarity threshold', async () => {
    const f = await fixture();
    f.options.config!.duplicateSimilarityThreshold = 0.01;
    f.options.candidate.behavior = f.priors[0]!.text;
    f.options.candidate.priorArt.proposedDelta =
      'Restore a captured failure state, extending existing input initialization.';
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'accept',
      reason: 'supported-delta',
    });
  });
  it('recognizes an exact recorded candidate without a paid review but rechecks its source first', async () => {
    const f = await fixture();
    f.priors[0]!.candidateHash = capabilityProposalHash(f.options.candidate);
    f.priors[0]!.evidenceHash = capabilityReviewEvidenceHash(f.options.selection);
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'reject', reason: 'duplicate' });
    expect(f.sources.readCurrent).toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
  it('reconsiders unchanged proposal wording when its supporting capability versions differ', async () => {
    const f = await fixture();
    f.priors[0]!.candidateHash = capabilityProposalHash(f.options.candidate);
    f.priors[0]!.evidenceHash = capabilityHash('previous capability sources');
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'accept',
      reason: 'supported-delta',
    });
    expect(f.calls).toHaveLength(3);
  });
  it('passes remaining configured review time to the full source rerank, bounded by the cycle', async () => {
    const f = await fixture();
    f.options.config = { model: 'reviewer-model', timeoutMs: 180_000 };
    f.options.cycleDeadlineMs = Date.now() + 30_000;
    await runCapabilityDreamReview(f.options, f.deps);
    const options = vi.mocked(f.deps.rerank).mock.calls[0]![2]!;
    expect(options.timeoutMs).toBeGreaterThan(5_000);
    expect(options.timeoutMs).toBeLessThanOrEqual(30_000);
  });
  it('retains a rejection and calls neither scorer nor reviewer after the source deadline', async () => {
    const f = await fixture();
    f.options.cycleDeadlineMs = Date.now() - 1;
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result).toMatchObject({ verdict: 'unverified', reason: 'rerank-unavailable' });
    expect(f.deps.rerank).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
  it('requires the reranker to actually score candidates and preserves rejected prior attempts', async () => {
    const f = await fixture();
    f.priors.push(prior('wi:rejected', 'rejected-attempt'));
    f.setJudgment(judgment([...f.priors].reverse()));
    const passed = await runCapabilityDreamReview(f.options, f.deps);
    expect(passed.verdict, passed.note).toBe('accept');
    expect(passed.priorMatches[0]!.kind).toBe('rejected-attempt');
    f.deps.rerank = async (_q, priors) => ({ priors, outcome: { attempted: false, scored: 0, reason: 'unavailable' } });
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'unverified',
      reason: 'rerank-unavailable',
    });
  });
  it('supports a mechanism transfer when mapping, preconditions, both-unit contribution and falsifier are evidenced', async () => {
    const f = await fixture();
    f.options.candidate.relations[0]!.kind = 'transferable-invariant';
    f.options.candidate.relations[0]!.mapping = 'Transfer scoped-input reproducibility from A to B evaluation.';
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({ verdict: 'accept' });
    expect(f.calls[2]!.messages[0]!.content).toContain('transferable-invariant');
  });
  it('rejects a documented constraint conflict even when the model says accept', async () => {
    const f = await fixture();
    const review = judgment(f.priors);
    const constraint = '// requires live external state; saved state is insufficient';
    const source = f.options.selection.b.packet.sources[0]!;
    source.excerpt = textB + '\n' + constraint;
    source.sourceHash = capabilityHash(source.excerpt);
    source.excerptHash = source.sourceHash;
    source.endLine = 2;
    f.options.selection.b.contentVersion = capabilityContentVersion(f.options.selection.b.packet);
    await writeFile(join(f.root, source.path), source.excerpt);
    review.feasibility = {
      status: 'disproven',
      note: 'B requires live external state not captured by the proposed scope.',
      evidence: [{ ref: 'B:code', quote: constraint }],
    };
    f.setJudgment(review);
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'reject',
      reason: 'disproven',
      note: review.feasibility.note,
    });
  });
  it.each(['observation', 'prior', 'quote', 'relation', 'experiment'] as const)(
    'fails closed for incomplete or unsupported %s adjudication',
    async (mode) => {
      const f = await fixture();
      const review = judgment(f.priors);
      if (mode === 'observation') review.observations.pop();
      if (mode === 'prior') review.comparisons = [];
      if (mode === 'quote') review.feasibility.evidence[0]!.quote = 'imaginary source text';
      if (mode === 'relation') review.relation.status = 'unknown';
      if (mode === 'experiment') review.experiment.executable = null;
      f.setJudgment(review);
      expect((await runCapabilityDreamReview(f.options, f.deps)).verdict).toBe('unverified');
    },
  );
  it('refuses same-model and missing dreamer provenance before reads or spend', async () => {
    const f = await fixture();
    for (const dreamerModel of ['', ' REVIEWER-MODEL ']) {
      expect(await runCapabilityDreamReview({ ...f.options, dreamerModel }, f.deps)).toMatchObject({
        verdict: 'unverified',
        reason: 'reviewer-not-independent',
      });
    }
    expect(f.sources.search).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
  it('records both call outcomes and all successful spend when a held-out response is malformed', async () => {
    const f = await fixture();
    f.controlA.evidence[0]!.ref = 'B:code';
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.verdict).toBe('unverified');
    expect(result.controls.bOnly).not.toBeNull();
    expect(result.usage.costUsd).toBe(0.02);
    expect(f.calls).toHaveLength(2);
  });
  it('invalidates fresh evidence that changes while the reviewer is running', async () => {
    const f = await fixture();
    const original = f.options.llmCall;
    f.options.llmCall = async (input) => {
      const value = await original(input);
      if (f.calls.length === 3) await writeFile(join(f.root, 'fixtures/A.ts'), 'changed during review');
      return value;
    };
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'unverified',
      reason: 'source-changed-during-review',
    });
  });
  it.each(['relation', 'observation', 'test'] as const)('refuses unrelated but literal %s quotations', async (kind) => {
    const f = await fixture();
    const review = judgment(f.priors);
    if (kind === 'relation') review.relation.evidence = [quote('A')];
    if (kind === 'observation') review.observations[0]!.evidence = [quote('B')];
    if (kind === 'test') review.experiment.evidence = [quote('B')];
    f.setJudgment(review);
    expect((await runCapabilityDreamReview(f.options, f.deps)).verdict).toBe('unverified');
  });
  it('notices a prior edit outside its displayed excerpt', async () => {
    const f = await fixture();
    let reads = 0;
    f.sources.readCurrent = async (p) =>
      ++reads > 1 ? { ...p, sourceHash: capabilityHash('changed unseen tail') } : p;
    expect(await runCapabilityDreamReview(f.options, f.deps)).toMatchObject({
      verdict: 'unverified',
      reason: 'source-changed-during-review',
    });
  });
});

describe('production capability and Blender source adapter', () => {
  async function adapterFixture() {
    const f = await fixture();
    let plan = {
      workspaceId: scope.workspaceId,
      harnessSlug: scope.potSlug,
      planSlug: 'existing',
      content: 'Plan: current test setup initializes evaluation inputs. Preserve the scope constraint.',
    } as PlanRow;
    const ideas = [
      {
        ideaId: 'old-idea',
        lens: 'analogical' as const,
        rail: 'plan' as const,
        routedRef: 'plan:existing',
        title: 'Snapshot replay for evaluation',
        humanFeedback: 'Check scoped state.',
      },
    ];
    const run: DreamRun = {
      workspaceId: scope.workspaceId,
      potSlug: scope.potSlug,
      runId: 'rejected-1',
      cycleId: 'cycle-1',
      mode: 'manual',
      status: 'rejected',
      fragmentRefs: [],
      fragmentKinds: [],
      pairing: null,
      similarity: null,
      dreamerModel: 'generator-model',
      reviewerModel: 'reviewer-model',
      dreamUsage: null,
      reviewUsage: null,
      outcome: { insight: { text: 'Restore the complete system' } },
      review: { note: 'The state scope was not bounded.' },
      routedRef: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: null,
      startedAt: '2026-09-07T10:00:00Z',
      completedAt: '2026-09-07T10:01:00Z',
      spendRecordedAt: null,
      updatedAt: '2026-09-07T10:01:00Z',
    };
    const deps: CapabilityReviewSourceDeps = {
      plans: vi.fn(async () => ({ rows: [plan], truncated: false })),
      plan: vi.fn(async () => plan),
      ideas: vi.fn(async () => ideas),
      runs: vi.fn(async () => [run]),
      run: vi.fn(async () => run),
      verifyPacket: f.deps.verifyPacket,
    };
    const sources = buildCapabilityReviewSources(
      {
        sql: {} as Sql,
        scope,
        rootPath: f.root,
        manifest: f.options.manifest,
        packets: [f.options.selection.a.packet, f.options.selection.b.packet],
      },
      deps,
    );
    const request: CapabilityReviewSearch = {
      facet: 'mechanism',
      query: 'scoped snapshot evaluation replay',
      scope,
      kinds: CAPABILITY_PRIOR_KINDS,
      limit: 8,
    };
    return {
      f,
      deps,
      sources,
      request,
      run,
      setPlan: (content: string) => {
        plan = { ...plan, content };
      },
    };
  }
  it('retrieves code/tests, archived plans, ordinary Blender ideas and rejected attempts within explicit scope', async () => {
    const a = await adapterFixture();
    const answer = await a.sources.search(a.request);
    expect(new Set(answer.matches.map((p) => p.kind))).toEqual(new Set(CAPABILITY_PRIOR_KINDS));
    expect(a.deps.plans).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ workspaceId: 'ws', harnessSlug: 'pot', includeArchived: true }),
    );
    expect(a.deps.ideas).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', harnessSlug: 'pot', origin: 'all' }),
    );
    expect(a.deps.runs).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: 'ws', potSlug: 'pot' }),
    );
    expect(answer.note).toContain('Unmapped code');
    expect(answer.matches.find((p) => p.ref === 'dream:rejected-1')!.text).toContain('state scope was not bounded');
    for (const p of answer.matches) expect(await a.sources.readCurrent(p)).toEqual(p);
  });
  it('shares history only within the search phase and re-reads authoritative evidence for adjudication', async () => {
    const a = await adapterFixture();
    const [first] = await Promise.all(
      ['purpose', 'mechanism', 'evaluation'].map((facet) =>
        a.sources.search({ ...a.request, facet: facet as CapabilityReviewSearch['facet'] }),
      ),
    );
    expect(a.deps.ideas).toHaveBeenCalledTimes(1);
    expect(a.deps.runs).toHaveBeenCalledTimes(1);
    const citedPlan = first!.matches.find((p) => p.kind === 'plan')!;
    a.setPlan('Changed authoritative plan');
    expect((await a.sources.readCurrent(citedPlan))!.sourceHash).not.toBe(citedPlan.sourceHash);
  });
  it('resolves persisted source locators after restart without relying on the original search cache', async () => {
    const a = await adapterFixture();
    const saved = JSON.parse(JSON.stringify((await a.sources.search(a.request)).matches)) as CapabilityReviewPrior[];
    const restarted = buildCapabilityReviewSources(
      {
        sql: {} as Sql,
        scope,
        rootPath: a.f.root,
        manifest: a.f.options.manifest,
        packets: [a.f.options.selection.a.packet, a.f.options.selection.b.packet],
      },
      a.deps,
    );
    for (const prior of saved) expect(await restarted.readCurrent(prior)).toEqual(prior);
    expect(await restarted.readCurrent({ ...saved[0]!, ref: 'plan:not-the-saved-source' })).toBeNull();
  });
  it('binds the whole prior source even when its displayed text is capped', async () => {
    const a = await adapterFixture();
    a.setPlan('snapshot '.repeat(1_500) + 'old constraint');
    const p = (await a.sources.search(a.request)).matches.find((p) => p.kind === 'plan')!;
    a.setPlan('snapshot '.repeat(1_500) + 'new constraint');
    const current = (await a.sources.readCurrent(p))!;
    expect(current.text).toBe(p.text);
    expect(current.sourceHash).not.toBe(p.sourceHash);
  });
  it('rechecks actual code files through the packet verifier', async () => {
    const a = await adapterFixture();
    const p = (await a.sources.search(a.request)).matches.find((p) => p.ref === 'code:capability:A:implementation')!;
    await writeFile(join(a.f.root, 'fixtures/A.ts'), 'different implementation');
    await expect(a.sources.readCurrent(p)).rejects.toThrow('Source changed');
  });
  it('uses fresh stored proposal identity for exact duplicates', async () => {
    const a = await adapterFixture();
    a.run.outcome = { insight: { capability: a.f.options.candidate } };
    const p = (await a.sources.search(a.request)).matches.find((p) => p.ref === 'dream:rejected-1')!;
    expect(p.candidateHash).toBe(capabilityProposalHash(a.f.options.candidate));
  });
  it('does not widen cross-scope reads and does not conceal backend failures', async () => {
    const a = await adapterFixture();
    await expect(a.sources.search({ ...a.request, scope: { ...scope, workspaceId: 'foreign' } })).rejects.toThrow(
      'scope',
    );
    a.deps.plans = vi.fn(async () => {
      throw new Error('plans unavailable');
    });
    await expect(a.sources.search(a.request)).rejects.toThrow('plans unavailable');
  });
  it('runs the complete verifier with the production adapter and current filesystem evidence', async () => {
    const a = await adapterFixture();
    const f = a.f;
    f.options.sources = a.sources;
    const llm = f.options.llmCall;
    f.options.llmCall = async (input) => {
      const request = JSON.parse(input.messages[0]!.content as string);
      if (request.priors) f.setJudgment(judgment(request.priors));
      return llm(input);
    };
    const result = await runCapabilityDreamReview(f.options, f.deps);
    expect(result.verdict, result.note).toBe('accept');
    expect(result.priorMatches.some((p) => p.kind === 'rejected-attempt')).toBe(true);
    expect(result.coverage.globalNovelty).toBe('not-established');
  });
});
