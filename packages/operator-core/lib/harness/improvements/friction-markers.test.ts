import { describe, it, expect } from 'vitest';
import {
  UNIVERSAL_FRICTION_MARKERS,
  HARNESS_PIPELINE_FRICTION_MARKERS,
  FRICTION_QUALITY_BAR,
  renderFrictionTripwire,
  renderReflectStep,
} from './friction-markers';

/**
 * The marker SPLIT is the contract (self-learning-central P-002): the default
 * (harness-free) loop must never reference roles that exist only inside a coding
 * harness. These tests pin that the two sets stay DISTINCT and that the
 * pipeline-only language is gated.
 */
describe('friction-markers — the universal vs harness-pipeline split (P-002)', () => {
  it('keeps the two marker sets disjoint by id', () => {
    const uni = new Set(UNIVERSAL_FRICTION_MARKERS.map((m) => m.id));
    const pipe = new Set(HARNESS_PIPELINE_FRICTION_MARKERS.map((m) => m.id));
    for (const id of pipe) expect(uni.has(id)).toBe(false);
    expect(uni.size).toBe(UNIVERSAL_FRICTION_MARKERS.length); // ids unique
    expect(pipe.size).toBe(HARNESS_PIPELINE_FRICTION_MARKERS.length);
  });

  it('universal markers cover the documented signals incl. the web-search-after-3-loops marker', () => {
    const ids = UNIVERSAL_FRICTION_MARKERS.map((m) => m.id);
    expect(ids).toContain('retry-or-repeated-tool-error');
    expect(ids).toContain('workaround');
    expect(ids).toContain('confusing-failure-after-n-attempts');
    expect(ids).toContain('lock-or-coord-contention');
    // The existing "search the web after ~3 loops" marker is the confusing-failure one.
    const confusing = UNIVERSAL_FRICTION_MARKERS.find((m) => m.id === 'confusing-failure-after-n-attempts');
    expect(confusing?.signal.toLowerCase()).toMatch(/3 attempts|web-search|web search/);
  });

  it('pipeline-only markers are the validator-fail and reviewer-returns-work roles', () => {
    const ids = HARNESS_PIPELINE_FRICTION_MARKERS.map((m) => m.id);
    expect(ids).toEqual(['validator-failed', 'reviewer-returned-work']);
  });

  it('NO universal marker mentions a harness-pipeline role (validator/reviewer)', () => {
    for (const m of UNIVERSAL_FRICTION_MARKERS) {
      expect(m.signal.toLowerCase()).not.toMatch(/validator|reviewer/);
    }
  });
});

describe('renderFrictionTripwire — the near-zero shared-base trip-wire (P-001/A)', () => {
  it('names improvements:capture, the quality bar, and is NOT a per-turn reflection pass', () => {
    const t = renderFrictionTripwire();
    expect(t).toContain('improvements:capture');
    expect(t).toMatch(/GENUINE, REPEATABLE/);
    expect(t.toLowerCase()).toContain('trip on real');
    // It is a trip-wire — it must NOT instruct a per-turn reflection pass.
    expect(t.toLowerCase()).toContain("don't reflect every turn");
  });

  it('does NOT leak harness-pipeline role names into the default base', () => {
    expect(renderFrictionTripwire().toLowerCase()).not.toMatch(/validator|reviewer/);
  });
});

describe('renderReflectStep — the completion-boundary structured step (P-001/B)', () => {
  it('renders the universal markers and the quality bar by default (no harness)', () => {
    const s = renderReflectStep();
    expect(s).toContain(FRICTION_QUALITY_BAR);
    for (const m of UNIVERSAL_FRICTION_MARKERS) expect(s).toContain(m.signal);
    // harness-free: no validator/reviewer language
    expect(s.toLowerCase()).not.toMatch(/validator|reviewer/);
  });

  it('adds the pipeline markers ONLY when the unit of work ran the coding harness', () => {
    const s = renderReflectStep({ harnessActive: true });
    for (const m of HARNESS_PIPELINE_FRICTION_MARKERS) expect(s).toContain(m.signal);
    expect(s.toLowerCase()).toMatch(/validator|reviewer/);
  });

  it('tells the agent to capture nothing when nothing genuine bit it (sparseness)', () => {
    expect(renderReflectStep().toLowerCase()).toContain('capture nothing');
  });
});
