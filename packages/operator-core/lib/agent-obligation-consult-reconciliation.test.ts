/**
 * EI-23764501791910357 — a consult opened under `latency_contract:'proceed'` creates an
 * UNRECONCILED-ASSUMPTION debt. The provider turns each unreconciled consult into one
 * obligation row so the debt survives a compaction and has a terminal state.
 *
 * These pin the contract the three phases depend on, and the two properties that are
 * easy to regress silently: an EMPTY read renders NO row (a placeholder would shift the
 * primary-obligation count every agenda carries — WI-10002424), and an UNREADABLE read
 * must not collapse into the empty case.
 */
import { describe, expect, it } from 'vitest';
import { formatAgentObligationLine } from './agent-obligations';
import {
  buildAgentObligationAgenda,
  consultReconciliationObligations,
  CONSULT_RECONCILIATION_OBLIGATION_REVISION,
  type ConsultReconciliationRow,
} from './agent-obligation-providers';

const BASE = {
  workspaceId: 'papercusp-workspace',
  ownerId: 'su-originator',
  observedAt: '2026-10-01T23:00:00.000Z',
  sourceGeneration: 'gen-1',
};

function row(overrides: Partial<ConsultReconciliationRow> = {}): ConsultReconciliationRow {
  return {
    consultId: 'consult-abc',
    phase: 'pending',
    assumption: 'assume the migration number is 811 and proceed',
    originTaskRef: 'EI-1',
    settledAt: null,
    expiresAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('consultReconciliationObligations', () => {
  it('renders NO row for an empty read — a placeholder would change the agenda count (WI-10002424)', () => {
    expect(consultReconciliationObligations({ ...BASE, read: { status: 'known', value: [] } })).toEqual([]);
  });

  it('keeps an UNREADABLE source visible as one unknown row, never as "no debt"', () => {
    const out = consultReconciliationObligations({
      ...BASE,
      read: {
        status: 'unknown',
        failure: { code: 'canonical-consult-reconciliation-read-failed', detail: 'consult_state read threw', retry: 'retry the read' },
      } as never,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('unknown');
    expect(out[0]?.family).toBe('consult-reconciliation');
  });

  it('a still-open consult is in-progress and carries its lapse deadline', () => {
    const [o] = consultReconciliationObligations({ ...BASE, read: { status: 'known', value: [row()] } });
    expect(o?.status).toBe('in-progress');
    expect(o?.priority).toBe('normal');
    expect(o?.dueAt).toBe('2026-10-02T00:00:00.000Z');
    expect(o?.title).toContain('consult-abc');
    expect(o?.reason).toContain('assume the migration number is 811');
  });

  it('names the discharge verb and gives a route for stale operator builds', () => {
    const [obligation] = consultReconciliationObligations({ ...BASE, read: { status: 'known', value: [row()] } });
    expect(obligation?.action?.tool).toBe('consult:reconcile');
    if (!obligation) throw new Error('expected a consult reconciliation obligation');
    const line = formatAgentObligationLine(obligation, 'action');
    expect(line).toContain('consult:reconcile');
    expect(line).toContain('if unavailable on this operator, use staging (:3170)');
  });

  it('an ANSWERED consult is due at high priority — the reply may falsify work already built', () => {
    const [o] = consultReconciliationObligations({
      ...BASE,
      read: { status: 'known', value: [row({ phase: 'answered', settledAt: '2026-10-01T22:00:00.000Z', expiresAt: null })] },
    });
    expect(o?.status).toBe('due');
    expect(o?.priority).toBe('high');
    expect(o?.dueAt).toBeUndefined();
    expect(o?.reason).toContain('diff the reply');
  });

  it('an UNANSWERED consult is due and says silence does not confirm the assumption', () => {
    const [o] = consultReconciliationObligations({
      ...BASE,
      read: { status: 'known', value: [row({ phase: 'unanswered', settledAt: '2026-10-01T22:00:00.000Z', expiresAt: null })] },
    });
    expect(o?.status).toBe('due');
    expect(o?.priority).toBe('normal');
    expect(o?.reason).toContain('silence does not confirm');
  });

  it('is ONE obligation per consult, with a stable id across re-renders of the same consult', () => {
    const a = consultReconciliationObligations({ ...BASE, read: { status: 'known', value: [row(), row({ consultId: 'consult-def' })] } });
    const b = consultReconciliationObligations({
      ...BASE,
      observedAt: '2026-10-01T23:30:00.000Z',
      read: { status: 'known', value: [row(), row({ consultId: 'consult-def' })] },
    });
    expect(a).toHaveLength(2);
    expect(a.map((o) => o.id)).toEqual(b.map((o) => o.id));
    expect(new Set(a.map((o) => o.id)).size).toBe(2);
  });

  it('a consult changing phase is the SAME obligation (same episode), so it updates rather than duplicates', () => {
    const [pending] = consultReconciliationObligations({ ...BASE, read: { status: 'known', value: [row()] } });
    const [answered] = consultReconciliationObligations({
      ...BASE,
      read: { status: 'known', value: [row({ phase: 'answered', settledAt: '2026-10-01T22:00:00.000Z' })] },
    });
    expect(pending?.episode).toBe(answered?.episode);
  });

  it('stamps its own rule revision so a later revision cannot silently reuse these rows', () => {
    const [o] = consultReconciliationObligations({ ...BASE, read: { status: 'known', value: [row()] } });
    expect(o?.ruleRevision).toBe(CONSULT_RECONCILIATION_OBLIGATION_REVISION);
  });

  it('flows through the agenda builder, and omitting the input adds no obligation', () => {
    const withConsult = buildAgentObligationAgenda(
      { consultReconciliation: { ...BASE, read: { status: 'known', value: [row({ phase: 'answered' })] } } },
      BASE.observedAt,
    );
    const without = buildAgentObligationAgenda({}, BASE.observedAt);
    expect(without.evaluations).toHaveLength(0);
    expect(withConsult.evaluations.filter((o) => o.family === 'consult-reconciliation')).toHaveLength(1);
    // The answered consult is actionable, so it must reach the ranked `primary` set too.
    expect(withConsult.primary.map((o) => o.family)).toContain('consult-reconciliation');
  });
});
