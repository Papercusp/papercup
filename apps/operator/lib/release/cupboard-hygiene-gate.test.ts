/**
 * cupboard-hygiene-gate.test — EI-11118 durable fix for cupboard-public-release
 * P-009 (E2E/federation/smoke flows publish junk to the LIVE prod Cupboard and
 * nothing catches a re-accumulation). Pins the two load-bearing rules:
 * DEFAULT-ON (unlike perf/delta-gate, this gate is enabled unless explicitly
 * turned off — see the file header in cupboard-hygiene-gate.ts) and
 * WARN-BY-DEFAULT / FAIL-SOFT (junk only blocks when block-mode is armed; a
 * total worker outage never holds a deploy hostage).
 */
import { describe, expect, it } from 'vitest';
import {
  cupboardHygienePolicyFromEnv,
  evaluateCupboardHygieneGate,
  runCupboardHygieneGate,
  type CupboardHygienePolicy,
} from './cupboard-hygiene-gate';
import type { CupboardTestRow } from '@papercusp/operator-core/lib/cupboard/prod-hygiene';
import { LISTING_KINDS } from '@papercusp/operator-core/lib/cupboard/types';

const OFF: CupboardHygienePolicy = { enabled: false, block: false };
const WARN_ONLY: CupboardHygienePolicy = { enabled: true, block: false };
const ARMED: CupboardHygienePolicy = { enabled: true, block: true };

const JUNK: CupboardTestRow[] = [
  { kind: 'harness', id: 'h1', ref: 'papercupai/psu-fed-e2e-1720000000' },
  { kind: 'blueprint', id: 'b1', ref: 'papercupai/cupboard-verify-smoke' },
];

describe('evaluateCupboardHygieneGate — pure decision', () => {
  it('disabled gate is a no-op pass even with junk present', () => {
    const d = evaluateCupboardHygieneGate(JUNK, OFF, 'abcdef1234');
    expect(d.action).toBe('pass');
    expect(d.summary).toContain('disabled');
    expect(d.summary).toContain('abcdef12');
  });

  it('no junk found → pass', () => {
    const d = evaluateCupboardHygieneGate([], WARN_ONLY, 'abcdef1234');
    expect(d.action).toBe('pass');
    expect(d.summary).toMatch(/clean/);
  });

  it('junk found + warn-only policy → warn, never blocks', () => {
    const d = evaluateCupboardHygieneGate(JUNK, WARN_ONLY, 'abcdef1234');
    expect(d.action).toBe('warn');
    expect(d.summary).toMatch(/warn — block-mode not armed/);
    expect(d.reasons).toEqual(['harness: papercupai/psu-fed-e2e-1720000000', 'blueprint: papercupai/cupboard-verify-smoke']);
    expect(d.testRows).toEqual(JUNK);
  });

  it('junk found + armed policy → block', () => {
    const d = evaluateCupboardHygieneGate(JUNK, ARMED, 'abcdef1234');
    expect(d.action).toBe('block');
    expect(d.summary).toMatch(/BLOCKED \(block-mode armed\)/);
  });

  it('truncates the reasons list past 5 rows in the summary (still returns them all in .reasons)', () => {
    const many: CupboardTestRow[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'harness',
      ref: `papercupai/psu-fed-e2e-${i}`,
    }));
    const d = evaluateCupboardHygieneGate(many, WARN_ONLY);
    expect(d.reasons).toHaveLength(8);
    expect(d.summary).toContain('+3 more');
  });
});

describe('cupboardHygienePolicyFromEnv', () => {
  it('defaults enabled (unlike perf/delta-gate) with block-mode off', () => {
    expect(cupboardHygienePolicyFromEnv({})).toEqual({ enabled: true, block: false });
  });

  it('PAPERCUSP_CUPBOARD_HYGIENE_GATE=0 disables it', () => {
    expect(cupboardHygienePolicyFromEnv({ PAPERCUSP_CUPBOARD_HYGIENE_GATE: '0' }).enabled).toBe(false);
  });

  it('PAPERCUSP_CUPBOARD_HYGIENE_GATE_BLOCK=1 arms block-mode', () => {
    expect(cupboardHygienePolicyFromEnv({ PAPERCUSP_CUPBOARD_HYGIENE_GATE_BLOCK: '1' }).block).toBe(true);
  });
});

describe('runCupboardHygieneGate — IO-seam', () => {
  it('disabled: reads nothing (browse never called)', async () => {
    let called = false;
    const d = await runCupboardHygieneGate(OFF, 'abc1234', {
      browse: async () => {
        called = true;
        return { ok: true, listings: [] };
      },
    });
    expect(d.action).toBe('pass');
    expect(called).toBe(false);
  });

  it('scans all kinds and warns on found junk', async () => {
    const d = await runCupboardHygieneGate(WARN_ONLY, 'abc1234', {
      browse: async (kind) =>
        kind === 'harness'
          ? { ok: true, listings: [{ id: 'h1', listing_ref: 'papercupai/psu-fed-e2e-1' }] }
          : { ok: true, listings: [] },
    });
    expect(d.action).toBe('warn');
    expect(d.testRows).toEqual([{ kind: 'harness', id: 'h1', ref: 'papercupai/psu-fed-e2e-1' }]);
  });

  it('clean storefront → pass', async () => {
    const d = await runCupboardHygieneGate(WARN_ONLY, 'abc1234', {
      browse: async () => ({ ok: true, listings: [{ id: 'x', listing_ref: 'acme/shop' }] }),
    });
    expect(d.action).toBe('pass');
  });

  it('total worker outage (every kind fails) fail-softs to pass, worded as unscanned not clean', async () => {
    const d = await runCupboardHygieneGate(WARN_ONLY, 'abc1234', {
      browse: async () => ({ ok: false, listings: [], error: 'ECONNREFUSED' }),
    });
    expect(d.action).toBe('pass');
    expect(d.summary).toMatch(/unreachable/);
    expect(d.summary).not.toMatch(/clean/);
    expect(d.summary).toContain(`${LISTING_KINDS.length}/${LISTING_KINDS.length}`);
  });

  it('partial outage (one kind fails, junk found in another) still warns, noting the partial scan', async () => {
    const d = await runCupboardHygieneGate(WARN_ONLY, 'abc1234', {
      browse: async (kind) => {
        if (kind === 'plugin') return { ok: false, listings: [], error: 'timeout' };
        if (kind === 'harness') return { ok: true, listings: [{ id: 'h1', listing_ref: 'papercupai/psu-fed-e2e-1' }] };
        return { ok: true, listings: [] };
      },
    });
    expect(d.action).toBe('warn');
    expect(d.summary).toMatch(/partial scan/);
    expect(d.summary).toContain('plugin');
  });

  it('a throwing scan (never happens in practice; scanCupboardForTestRows itself catches) still fail-softs', async () => {
    const d = await runCupboardHygieneGate(WARN_ONLY, 'abc1234', {
      browse: async () => {
        throw new Error('boom');
      },
    });
    expect(d.action).toBe('pass');
  });
});
