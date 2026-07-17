/**
 * carry-drill-retire.test.ts — session:carry-drill op:'retire'/'unretire' (P-019
 * D-010 leg 3: retirement actuation). Pins the tool-layer contract:
 *   • retire REFUSES (ok:false, error:'insufficient-evidence') unless the class's
 *     OWN live report already says retire:true — never applies the raw
 *     scoreResidualMissRate recommendation automatically (D-001).
 *   • a class that clears the gate is retired with the report's evidence pinned.
 *   • op:'report' surfaces the retired-classes map alongside the residual corpus.
 *   • unretire is reversible and reports whether a record existed.
 *
 * cold-boot-drill-live is mocked out entirely — irrelevant to these ops, and its
 * real module reaches for a live host/DB this unit test must not touch.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/session/carry-drill-retire.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cold-boot-drill-live', () => ({
  startColdBootDrill: vi.fn(),
  gradeColdBootDrill: vi.fn(),
  verifyColdBootDrill: vi.fn(),
  reportColdBootDrills: vi.fn(async () => ({ ok: true, drills: 0 })),
}));
vi.mock('../../residual-carry-pass-live', () => ({
  reportResidualCarrySamples: vi.fn(),
  readRetiredResidualClasses: vi.fn(async () => ({})),
  retireResidualClass: vi.fn(),
  unretireResidualClass: vi.fn(),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-owner-1', ownerLabel: 'su · owner-1', workspaceId: 'default' })),
}));

import carryDrill from './carry-drill';
import {
  reportResidualCarrySamples,
  readRetiredResidualClasses,
  retireResidualClass,
  unretireResidualClass,
} from '../../residual-carry-pass-live';

const reportM = vi.mocked(reportResidualCarrySamples);
const readRetiredM = vi.mocked(readRetiredResidualClasses);
const retireM = vi.mocked(retireResidualClass);
const unretireM = vi.mocked(unretireResidualClass);

type Handler = (args: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
const handler = (carryDrill as unknown as { handler: Handler }).handler;
const body = (r: Awaited<ReturnType<Handler>>) => JSON.parse(r.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  readRetiredM.mockResolvedValue({});
});

describe("session:carry-drill op:'retire'", () => {
  it('refuses with insufficient-evidence when the class report says retire:false', async () => {
    reportM.mockResolvedValue({
      perClass: [{ sessionClass: 'claude-interactive', n: 5, materialCount: 0, errorCount: 0, missRate: 0, retire: false }],
      params: { epsilon: 0, minSample: 30, maxErrorFraction: 0.1 },
      retirableClasses: [],
    });
    const r = await handler({ op: 'retire', sessionClass: 'claude-interactive' }, {});
    expect(r.isError).toBe(true);
    expect(body(r)).toMatchObject({ ok: false, error: 'insufficient-evidence', sessionClass: 'claude-interactive' });
    expect(retireM).not.toHaveBeenCalled();
  });

  it('refuses with insufficient-evidence when the class has no report entry at all', async () => {
    reportM.mockResolvedValue({
      perClass: [],
      params: { epsilon: 0, minSample: 30, maxErrorFraction: 0.1 },
      retirableClasses: [],
    });
    const r = await handler({ op: 'retire', sessionClass: 'never-sampled' }, {});
    expect(body(r)).toMatchObject({ ok: false, error: 'insufficient-evidence', stats: null });
    expect(retireM).not.toHaveBeenCalled();
  });

  it('retires a class whose OWN report clears the gate, pinning the report evidence + the caller identity', async () => {
    reportM.mockResolvedValue({
      perClass: [{ sessionClass: 'claude-interactive', n: 41, materialCount: 0, errorCount: 1, missRate: 0, retire: true }],
      params: { epsilon: 0, minSample: 30, maxErrorFraction: 0.1 },
      retirableClasses: ['claude-interactive'],
    });
    retireM.mockResolvedValue({
      ok: true,
      record: {
        sessionClass: 'claude-interactive',
        retiredAt: '2026-07-17T00:00:00.000Z',
        retiredBy: 'su-owner-1',
        evidence: { n: 41, missRate: 0, errorCount: 1 },
      },
    });
    const r = await handler({ op: 'retire', sessionClass: 'claude-interactive', note: 'confirmed clean' }, {});
    expect(retireM).toHaveBeenCalledWith(
      'claude-interactive',
      { retiredBy: 'su-owner-1', evidence: { n: 41, missRate: 0, errorCount: 1 }, note: 'confirmed clean' },
    );
    expect(body(r)).toMatchObject({ ok: true, record: { sessionClass: 'claude-interactive' } });
    expect(r.isError).toBeUndefined();
  });
});

describe("session:carry-drill op:'unretire'", () => {
  it('forwards to unretireResidualClass and reports whether a record existed', async () => {
    unretireM.mockResolvedValue(true);
    const r = await handler({ op: 'unretire', sessionClass: 'claude-interactive' }, {});
    expect(unretireM).toHaveBeenCalledWith('claude-interactive');
    expect(body(r)).toEqual({ ok: true, removed: true });
  });
});

describe("session:carry-drill op:'report' — includes retiredClasses alongside the residual corpus", () => {
  it('folds readRetiredResidualClasses into the report payload', async () => {
    reportM.mockResolvedValue({ perClass: [], params: { epsilon: 0, minSample: 30, maxErrorFraction: 0.1 }, retirableClasses: [] });
    readRetiredM.mockResolvedValue({
      'claude-interactive': {
        sessionClass: 'claude-interactive',
        retiredAt: '2026-07-17T00:00:00.000Z',
        retiredBy: 'su-owner-1',
        evidence: { n: 41, missRate: 0, errorCount: 1 },
      },
    });
    const r = await handler({ op: 'report' }, {});
    const b = body(r);
    expect(b.retiredClasses['claude-interactive']).toMatchObject({ sessionClass: 'claude-interactive' });
    expect(b.residual).toBeDefined();
  });
});
