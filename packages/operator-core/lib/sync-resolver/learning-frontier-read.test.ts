/**
 * learning-frontier-read — the lane→flag map's completeness drift-guard +
 * the governor row↔lane matcher (learning-tab-visibility-2026-07-18 P-003).
 *
 * The completeness assert is the load-bearing test: a NEW workspace-singleton
 * learning loop cannot be added to LEARNING_SINGLETONS without deciding its
 * flag column here (an explicit null = "no flag gate, always-on"), so the
 * Frontier grid can never silently render a lane with an unknown gate.
 */
import { describe, expect, it } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { LEARNING_SINGLETONS } from '../blueprint/seed-learning-singletons';
import { FRONTIER_LANE_FLAGS, governorRowMatchesLane } from './learning-frontier-read';

describe('FRONTIER_LANE_FLAGS', () => {
  it('covers every LEARNING_SINGLETONS lane (explicit null = deliberately ungated)', () => {
    for (const loop of LEARNING_SINGLETONS) {
      expect(
        Object.prototype.hasOwnProperty.call(FRONTIER_LANE_FLAGS, loop.blueprintId),
        `LEARNING_SINGLETONS gained '${loop.blueprintId}' — add it to FRONTIER_LANE_FLAGS (a flag key, or an explicit null for an always-on/ungated lane) so the Frontier grid renders its gate column.`,
      ).toBe(true);
    }
  });

  it('maps only to real flag registry values', () => {
    const known = new Set(Object.values(FLAGS));
    for (const [lane, key] of Object.entries(FRONTIER_LANE_FLAGS)) {
      if (key == null) continue;
      expect(known.has(key), `lane '${lane}' maps to '${key}', which is not a FLAGS value`).toBe(true);
    }
  });

  it('has no orphan lanes (every mapped lane exists in LEARNING_SINGLETONS)', () => {
    const ids = new Set(LEARNING_SINGLETONS.map((l) => l.blueprintId));
    for (const lane of Object.keys(FRONTIER_LANE_FLAGS)) {
      expect(ids.has(lane), `FRONTIER_LANE_FLAGS maps '${lane}', which is not a LEARNING_SINGLETONS blueprintId`).toBe(true);
    }
  });
});

describe('governorRowMatchesLane', () => {
  it('matches exact ids and the <id>:<scope> convention', () => {
    expect(governorRowMatchesLane('regret', 'regret')).toBe(true);
    expect(governorRowMatchesLane('regret:papercusp', 'regret')).toBe(true);
  });

  it("matches scout's blender: registration prefix", () => {
    expect(governorRowMatchesLane('blender:papercusp', 'scout')).toBe(true);
  });

  it('does not match unrelated registrations', () => {
    expect(governorRowMatchesLane('gym:papercusp', 'scout')).toBe(false);
    expect(governorRowMatchesLane('gym:papercusp', 'regret')).toBe(false);
  });
});
