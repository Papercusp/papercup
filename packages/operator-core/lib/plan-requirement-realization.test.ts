/**
 * P-014: the activation↔completion audit join. See ./plan-requirement-realization.ts.
 *
 * The two exemption rules (non-item targets, non-realizing dispositions) are the
 * dangerous half of this judge: each one makes the gate PASS, so a bug in either is
 * invisible in production and shows up only as a plan that shipped unproven. They
 * get explicit both-directions coverage rather than a single happy-path case.
 */
import { describe, it, expect } from 'vitest';
import {
  judgeRequirementRealization,
  describeUnrealized,
  type RequirementRealizationInput,
} from './plan-requirement-realization';
import type { ActivationAuditMapping, AuditCitation, EffectiveItemAudit } from './plan-audits';

const mapping = (over: Partial<ActivationAuditMapping> = {}): ActivationAuditMapping => ({
  id: 'M-001',
  sourceRefs: ['session_turn:owner:s1:12'],
  requirement: 'the gate must refuse an unproven requirement',
  planTargets: ['P-001'],
  disposition: 'covered',
  ...over,
});

const itemAudit = (itemId: string, citations: AuditCitation[]): EffectiveItemAudit => ({
  auditSeq: 1,
  entry: { itemId, verdict: 'implemented', citations },
});

const CODE: AuditCitation = { kind: 'code', path: 'packages/operator-core/lib/x.ts' };
const TEST: AuditCitation = { kind: 'test', path: 'packages/operator-core/lib/x.test.ts' };
const DOC: AuditCitation = { kind: 'doc', ref: 'internal/docs/x', reason: 'design note' };
const NONE: AuditCitation = { kind: 'none', reason: 'investigation only' };

const judge = (i: RequirementRealizationInput) => judgeRequirementRealization(i);

describe('judgeRequirementRealization', () => {
  describe('the violations it must catch', () => {
    it('catches a covered requirement whose target has NO item audit', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [] });
      expect(v.ok).toBe(false);
      expect(v.unrealized).toHaveLength(1);
      expect(v.unrealized[0]?.reason).toBe('no-item-audit');
      expect(v.unrealized[0]?.planTarget).toBe('P-001');
    });

    it('catches a covered requirement audited with only a doc citation (D-008)', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [DOC])] });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.reason).toBe('no-verifying-citation');
    });

    it("catches `none` citations too — the honest escape is still not verification", () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [NONE])] });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.reason).toBe('no-verifying-citation');
    });

    it('catches a `repaired` mapping, not just `covered`', () => {
      const v = judge({
        mappings: [mapping({ disposition: 'repaired' })],
        itemAudits: [itemAudit('P-001', [DOC])],
      });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.disposition).toBe('repaired');
    });

    it('reports EVERY failing target of a multi-target mapping, not just the first', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['P-001', 'P-002', 'P-003'] })],
        itemAudits: [itemAudit('P-002', [CODE])],
      });
      expect(v.ok).toBe(false);
      expect(v.unrealized.map((u) => u.planTarget)).toEqual(['P-001', 'P-003']);
      expect(v.checkedTargets).toBe(3);
    });
  });

  describe('the exemptions — each one makes the gate PASS, so both directions matter', () => {
    it('passes when a verifying code citation backs the target', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [CODE])] });
      expect(v.ok).toBe(true);
      expect(v.checkedTargets).toBe(1);
    });

    it('accepts a test citation as verification', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [TEST])] });
      expect(v.ok).toBe(true);
    });

    it('accepts a mix so long as at least one citation verifies', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [DOC, NONE, CODE])] });
      expect(v.ok).toBe(true);
    });

    it('SKIPS D-NNN targets — decisions have no completion-audit counterpart', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['D-004'] })], itemAudits: [] });
      expect(v.ok).toBe(true);
      expect(v.skippedTargets).toEqual(['D-004']);
      expect(v.checkedTargets).toBe(0);
    });

    it('SKIPS section: targets', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['section:Risks'] })], itemAudits: [] });
      expect(v.ok).toBe(true);
      expect(v.skippedTargets).toEqual(['section:Risks']);
    });

    it('still judges the P-NNN targets of a mapping that ALSO has exempt ones', () => {
      const v = judge({
        mappings: [mapping({ planTargets: ['D-004', 'P-001', 'section:Risks'] })],
        itemAudits: [],
      });
      expect(v.ok).toBe(false);
      expect(v.checkedTargets).toBe(1);
      expect(v.skippedTargets).toEqual(['D-004', 'section:Risks']);
    });

    it('ignores `rejected` and `open` — they claim no absorption, so they owe no evidence', () => {
      const v = judge({
        mappings: [
          mapping({ id: 'M-001', disposition: 'rejected' }),
          mapping({ id: 'M-002', disposition: 'open' }),
        ],
        itemAudits: [],
      });
      expect(v.ok).toBe(true);
      expect(v.checkedTargets).toBe(0);
    });

    it('is vacuously ok with no mappings at all', () => {
      const v = judge({ mappings: [], itemAudits: [] });
      expect(v.ok).toBe(true);
      expect(v.checkedTargets).toBe(0);
    });
  });

  describe('robustness', () => {
    it('tolerates whitespace around a target id', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['  P-001  '] })], itemAudits: [] });
      expect(v.ok).toBe(false);
      expect(v.unrealized[0]?.planTarget).toBe('P-001');
    });

    it('does not treat a P-NNN-ish string as a plan item', () => {
      const v = judge({ mappings: [mapping({ planTargets: ['P-1', 'PP-001', 'P-001x'] })], itemAudits: [] });
      expect(v.checkedTargets).toBe(0);
      expect(v.skippedTargets).toEqual(['P-1', 'PP-001', 'P-001x']);
    });
  });

  describe('describeUnrealized', () => {
    it('names the mapping, disposition, target and why', () => {
      const v = judge({ mappings: [mapping()], itemAudits: [itemAudit('P-001', [DOC])] });
      const line = describeUnrealized(v.unrealized[0]!);
      expect(line).toContain('M-001');
      expect(line).toContain('covered');
      expect(line).toContain('P-001');
      expect(line).toContain('no verifying');
    });

    it('truncates a long requirement so one entry cannot swallow the message', () => {
      const v = judge({
        mappings: [mapping({ requirement: 'x'.repeat(300) })],
        itemAudits: [],
      });
      expect(describeUnrealized(v.unrealized[0]!).length).toBeLessThan(200);
    });
  });
});
