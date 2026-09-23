import { describe, expect, it } from 'vitest';

import {
  bareWorkItemRefs,
  refComponents,
  workItemRefBlockerProblem,
} from './work-item-ref-blocker-guard';

const problem = (ref: string) => workItemRefBlockerProblem({ itemId: 'WI-1', ref });

describe('workItemRefBlockerProblem', () => {
  describe('refuses a ref that names work-items and nothing else', () => {
    // Every id here was observed as a live blocker ref in harness papercusp.
    it.each(['WI-40086', 'EI-21330406073681578', 'WI-212675', 'WI-40474', 'EI-44'])(
      'refuses bare id %s',
      (ref) => {
        const found = problem(ref);
        expect(found?.code).toBe('work_item_ref_as_external_blocker');
        expect(found?.offendingRefs).toEqual([ref]);
      },
    );

    it('refuses regardless of id family', () => {
      expect(problem('F-2141')?.offendingRefs).toEqual(['F-2141']);
    });

    it('refuses case-insensitively, so a lowercased id cannot slip through', () => {
      expect(problem('wi-40086')?.offendingRefs).toEqual(['wi-40086']);
    });

    it('tolerates surrounding whitespace', () => {
      expect(problem('  WI-40086  ')?.offendingRefs).toEqual(['WI-40086']);
    });

    it('names every offending component of a multi-part ref', () => {
      // Observed on EI-21269301967233941: two dead ids plus one live condition.
      const found = problem('WI-40086; WI-41117; dev:pipeline_position:packages/x.ts');
      expect(found?.offendingRefs).toEqual(['WI-40086', 'WI-41117']);
      // The live third component is not reported as offending.
      expect(found?.offendingRefs).not.toContain('dev:pipeline_position:packages/x.ts');
    });

    it('splits on commas as well as semicolons', () => {
      expect(problem('WI-40086, WI-41117')?.offendingRefs).toEqual(['WI-40086', 'WI-41117']);
    });

    it('points at both repairs and quotes the offending id in each', () => {
      const detail = problem('WI-40086')?.detail ?? '';
      expect(detail).toContain("work_items:link { id:");
      expect(detail).toContain("work_items:link { id: 'WI-40086', rel:'blocks', target_id: 'WI-1' }");
      expect(detail).not.toContain('source_id');
      expect(detail).toContain('WI-40086');
      // The external-condition repair must be offered too: many real refs name a
      // gate or an owner decision, not a work-item dependency.
      expect(detail).toContain('qualifier');
      expect(detail).toContain('work-item:done:WI-40086');
    });
  });

  describe('accepts a ref that carries information beyond the id', () => {
    // BOUND 1 — these are all real, legitimate refs from the live population.
    // A guard that refused them would be worse than the bug it replaces.
    it.each([
      'WI-212675 / gate-red-streak:papercusp',
      'gate.greenCheckpoint / WI-212675',
      'gate-red-streak:papercusp / WI-40086',
      'gate.greenCheckpoint.ownership / WI-212675',
      'EI-19458231972377007-owner-provenance',
      'EI-19395667449143812:hmr-duplicate-registry-disposition',
      'EI-19967260725602869#agent-review',
      'owner-capability:EI-8574:external-service-action',
      'EI-21048549665261701-owner-authorization',
      'EI-20467401893261300 Typesense parity policy',
      'EI-10567/EI-10634',
    ])('accepts qualified ref %s', (ref) => {
      expect(problem(ref)).toBeNull();
    });

    it('never splits on "/", because live refs use it to qualify', () => {
      // If "/" were a separator, this legitimate gate ref would be refused —
      // the precise false positive bound 1 exists to prevent.
      expect(refComponents('WI-212675 / gate-red-streak:papercusp')).toEqual([
        'WI-212675 / gate-red-streak:papercusp',
      ]);
      expect(problem('WI-212675 / gate-red-streak:papercusp')).toBeNull();
    });

    // BOUND 2 — a live await key has a working clear path and is not refused.
    it.each([
      'work-item:done:WI-40509',
      'work-item:done:EI-21568004123678857',
      'work-item:unblocked:WI-40086',
      'work-item:WI-40069',
    ])('accepts event key %s', (ref) => {
      expect(problem(ref)).toBeNull();
    });

    it.each([
      'gate-red-streak:papercusp',
      'dev:pipeline_position:packages/operator-core/lib/x.ts',
      'owner decision P-201 (p2p-public-release-remaining-lanes-2026-07-16)',
      'green-checkpoint',
    ])('accepts ordinary external condition %s', (ref) => {
      expect(problem(ref)).toBeNull();
    });
  });

  describe('calibration — the classifier itself is not vacuous', () => {
    // These two hold on ANY revision of this file. If the "accepts" block above
    // ever passes because the classifier stopped detecting anything at all,
    // these fail and say so.
    it('still detects the canonical bad ref', () => {
      expect(bareWorkItemRefs('WI-40086')).toEqual(['WI-40086']);
    });

    it('still returns nothing for a ref containing no id at all', () => {
      expect(bareWorkItemRefs('gate-red-streak:papercusp')).toEqual([]);
    });
  });
});
