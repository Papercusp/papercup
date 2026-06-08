/**
 * router-deps.test.ts — production wiring of the Scout router dispatch ports (P-007).
 *
 * The underlying backends are tested elsewhere (capture-core.test.ts,
 * gym-bridge via its own tests); this pins the proposal→backend MAPPING +
 * the duplicate-decline attribution that only this file owns.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Proposal } from './types';
import type { ArchivePort, ArchiveEliteView } from './gym-bridge';
import type { CaptureImprovementInput, CaptureImprovementResult } from '../harness/improvements/capture-core';
import {
  buildCapturePort,
  buildGymDispatchPort,
  buildPlansNewPort,
  improvementBody,
  type PlanDraftCreator,
} from './router-deps';

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-1',
    framing: 'Wake-on-grant for blocked edits',
    mechanism: 'register a wake on lock grant + yield the turn',
    whyNew: 'no prior plan treats a block as a wake-trigger',
    bet: 'fewer wasted retries',
    cheapExperiment: { hypothesis: 'cuts spins', method: 'instrument a session', falsifiableSignal: 'spins unchanged' },
    sourceIdeaIds: ['idea-1', 'idea-2'],
    addressesPatternRefs: ['plan:lock-contention-2026-06-01'],
    ...over,
  };
}

describe('improvementBody', () => {
  it('composes the structured proposal fields into a readable body', () => {
    const body = improvementBody(proposal());
    expect(body).toContain('no prior plan treats a block');
    expect(body).toContain('**Mechanism:**');
    expect(body).toContain('**The bet:**');
    expect(body).toContain('Cheap experiment (D-006)');
    expect(body).toContain('Falsified if: spins unchanged');
    expect(body).toContain('Source ideas: idea-1, idea-2');
  });
});

describe('buildCapturePort', () => {
  it('files via captureImprovement as the Queen and returns the new issue id', async () => {
    const fake = vi.fn(
      async (_input: CaptureImprovementInput): Promise<CaptureImprovementResult> => ({
        ok: true,
        created: true,
        kind: 'change',
        issue: { id: 'EI-42' } as never,
        topics: [],
        possibleDuplicates: [],
      }),
    );
    const port = buildCapturePort({}, fake);
    const res = await port({ proposal: proposal() });

    expect(res).toEqual({ id: 'EI-42', created: true });
    const input = fake.mock.calls[0][0];
    expect(input.sourceRole).toBe('Queen'); // D-010 — Scout is prompt-free, the Queen gates
    expect(input.kind).toBe('change');
    expect(input.scope).toBe('operator');
  });

  it('on a duplicate decline, attributes to the EXISTING item (created:false)', async () => {
    const fake = vi.fn(
      async (_input: CaptureImprovementInput): Promise<CaptureImprovementResult> => ({
        ok: true,
        created: false,
        reason: 'likely-duplicate',
        possibleDuplicates: [{ id: 'EI-7', title: 'dup', state: 'open', severity: 'minor', similarity: 0.9 }],
      }),
    );
    const port = buildCapturePort({}, fake);
    const res = await port({ proposal: proposal() });
    expect(res).toEqual({ id: 'EI-7', created: false });
  });
});

describe('buildPlansNewPort', () => {
  it('shapes the proposal into a draft-plan create call and passes the slug stem through', async () => {
    const create = vi.fn<PlanDraftCreator>(async (args) => ({ slug: `${args.slug}-2026-06-08` }));
    const port = buildPlansNewPort(create);
    const res = await port({ proposal: proposal(), slugStem: 'scout-wake-on-grant' });

    expect(res.slug).toBe('scout-wake-on-grant-2026-06-08');
    const arg = create.mock.calls[0][0];
    expect(arg.slug).toBe('scout-wake-on-grant');
    expect(arg.title).toBe('Wake-on-grant for blocked edits');
    expect(arg.rationale).toContain('Scout-generated');
    expect(arg.rationale).toContain('idea-1, idea-2');
  });
});

describe('buildGymDispatchPort', () => {
  it('delegates to seedDistantNiches against the injected archive (empty archive → opens niches)', async () => {
    const seeded: { coords: unknown }[] = [];
    const archive: ArchivePort = {
      listElites: () => [] as ArchiveEliteView[],
      seed: (entry) => {
        seeded.push({ coords: entry.descriptor.coords });
        return { admitted: true, nicheKey: `niche-${seeded.length}` };
      },
    };
    const port = buildGymDispatchPort(archive);
    const res = await port([
      { id: 'prop-1', text: 'idea a' },
      { id: 'prop-2', text: 'idea b' },
    ]);
    // Empty archive ⇒ every seed lands in an open niche (noveltyDistance = Infinity).
    expect(res.newNiches).toHaveLength(2);
    expect(res.seeded.map((s) => s.ideaId)).toEqual(['prop-1', 'prop-2']);
    expect(res.seeded.every((s) => s.admitted)).toBe(true);
  });
});
