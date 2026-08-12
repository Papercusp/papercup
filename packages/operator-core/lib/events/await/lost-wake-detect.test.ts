/**
 * lost-wake-detect.test.ts — EI-10869. The detector must separate healthy from degenerate on the
 * exact live-data table validated in the ticket, and — the whole point of the witness leg — must
 * NOT convict a suspect with no independent evidence the underlying condition occurred.
 *
 * Run: cd packages/operator-core && npx vitest run lib/events/await/lost-wake-detect.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  judgeLostWakeSuspects,
  convictWithWitnesses,
  GREEN_CHECKPOINT_WITNESS,
  type LostWakeRateRow,
  type LostWakeWitness,
} from './lost-wake-detect';

const row = (event_key: string, fired_event: number, fired_timeout: number): LostWakeRateRow => ({
  event_key,
  fired_event,
  fired_timeout,
});

// The validated live table from the ticket (2026-07-13).
const LIVE_TABLE: LostWakeRateRow[] = [
  row('release:green:papercusp', 0, 88), // CONVICTED (EI-10800)
  row('overwatch:surface-landed', 0, 14), // suspect
  row('work-item:claimable', 1, 55), // suspect (1.7%)
  row('release:deploy-failed', 3, 16), // healthy (15.8%) — a timeout is CORRECT here
  row('green-checkpoint:red', 26, 3), // healthy (89.7%)
  row('spawn-slot:freed', 41, 2), // healthy (95.3%)
  row('coord:inbox-wake:x', 22, 0), // healthy (100%)
];

describe('judgeLostWakeSuspects', () => {
  it('separates the known-degenerate keys from the known-healthy ones on the validated live table', () => {
    const suspects = judgeLostWakeSuspects(LIVE_TABLE);
    const keys = suspects.map((s) => s.eventKey);
    expect(keys).toContain('release:green:papercusp');
    expect(keys).toContain('overwatch:surface-landed');
    expect(keys).toContain('work-item:claimable');
    // release:deploy-failed (15.8%) is GOOD NEWS, not a bug — must not be flagged.
    expect(keys).not.toContain('release:deploy-failed');
    expect(keys).not.toContain('green-checkpoint:red');
    expect(keys).not.toContain('spawn-slot:freed');
    expect(keys).not.toContain('coord:inbox-wake:x');
  });

  it('ranks worst (lowest real-fire rate) first', () => {
    const suspects = judgeLostWakeSuspects(LIVE_TABLE);
    expect(suspects[0]?.eventKey).toBe('release:green:papercusp');
    expect(suspects[0]?.pctRealFire).toBe(0);
  });

  it('says nothing about a key with too few settled awaits, even at 0% real-fire', () => {
    const suspects = judgeLostWakeSuspects([row('brand-new-key', 0, 2)], { minSettled: 5 });
    expect(suspects).toHaveLength(0);
  });

  it('honors a custom degenerateRatePct threshold', () => {
    // At the default 10% bar, work-item:claimable (1.7%) is a suspect; raise the bar to 1% and it
    // drops off, proving the threshold is actually load-bearing rather than hardcoded.
    const suspects = judgeLostWakeSuspects(LIVE_TABLE, { degenerateRatePct: 1 });
    expect(suspects.map((s) => s.eventKey)).not.toContain('work-item:claimable');
    expect(suspects.map((s) => s.eventKey)).toContain('release:green:papercusp');
  });
});

describe('convictWithWitnesses — the false-positive-machine guard', () => {
  const suspects = judgeLostWakeSuspects(LIVE_TABLE);

  it('convicts a suspect whose witness confirms the underlying condition occurred', async () => {
    const witness: LostWakeWitness = {
      name: 'fake-confirming-witness',
      owner: 'test',
      matches: (k) => k === 'release:green:papercusp',
      check: async () => ({ occurred: true, evidence: 'a green verdict landed independently' }),
    };
    const findings = await convictWithWitnesses({} as never, suspects, 7 * 24 * 60 * 60 * 1000, [witness]);
    const green = findings.find((f) => f.eventKey === 'release:green:papercusp');
    expect(green?.verdict).toBe('convicted');
    expect(green?.witness?.name).toBe('fake-confirming-witness');
  });

  it('leaves a suspect with NO matching witness as suspect — never auto-convicted', async () => {
    const findings = await convictWithWitnesses({} as never, suspects, 7 * 24 * 60 * 60 * 1000, []);
    for (const f of findings) {
      expect(f.verdict).toBe('suspect');
      expect(f.witness).toBeNull();
    }
  });

  it('leaves a suspect suspect when its witness cannot confirm occurrence — this is the false-positive guard', async () => {
    const witness: LostWakeWitness = {
      name: 'fake-denying-witness',
      owner: 'test',
      matches: (k) => k === 'release:green:papercusp',
      check: async () => ({ occurred: false, evidence: 'no green verdict in the window' }),
    };
    const findings = await convictWithWitnesses({} as never, suspects, 7 * 24 * 60 * 60 * 1000, [witness]);
    const green = findings.find((f) => f.eventKey === 'release:green:papercusp');
    expect(green?.verdict).toBe('suspect');
    expect(green?.witness).toBeNull();
  });

  it('leaves a suspect suspect when its witness cannot run at all (returns null — fail-soft)', async () => {
    const witness: LostWakeWitness = {
      name: 'fake-erroring-witness',
      owner: 'test',
      matches: (k) => k === 'release:green:papercusp',
      check: async () => null,
    };
    const findings = await convictWithWitnesses({} as never, suspects, 7 * 24 * 60 * 60 * 1000, [witness]);
    const green = findings.find((f) => f.eventKey === 'release:green:papercusp');
    expect(green?.verdict).toBe('suspect');
  });
});

describe('GREEN_CHECKPOINT_WITNESS.matches', () => {
  it('matches release:green and green-checkpoint:red, with or without a pipeline suffix', () => {
    expect(GREEN_CHECKPOINT_WITNESS.matches('release:green')).toBe(true);
    expect(GREEN_CHECKPOINT_WITNESS.matches('release:green:papercusp')).toBe(true);
    expect(GREEN_CHECKPOINT_WITNESS.matches('green-checkpoint:red')).toBe(true);
    expect(GREEN_CHECKPOINT_WITNESS.matches('green-checkpoint:red:papercusp')).toBe(true);
  });

  it('does not match an unrelated event key', () => {
    expect(GREEN_CHECKPOINT_WITNESS.matches('work-item:claimable')).toBe(false);
    expect(GREEN_CHECKPOINT_WITNESS.matches('overwatch:surface-landed')).toBe(false);
  });
});

describe('GREEN_CHECKPOINT_WITNESS.check', () => {
  it('queries only checkpoint statuses that emit a release:green event', async () => {
    const calls: { strings: readonly string[]; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return [{ n: 1, latest: '2026-08-12T12:00:00.000Z' }];
    }) as unknown as Parameters<typeof GREEN_CHECKPOINT_WITNESS.check>[0];

    const result = await GREEN_CHECKPOINT_WITNESS.check(
      sql,
      'release:green:papercusp',
      24 * 60 * 60 * 1000,
    );

    expect(result?.occurred).toBe(true);
    expect(calls[0]?.values).toContainEqual(['advanced', 'advanced-prefix']);
  });

  it('does not count an up-to-date verdict as evidence', async () => {
    const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
      return [];
    }) as unknown as Parameters<typeof GREEN_CHECKPOINT_WITNESS.check>[0];

    const result = await GREEN_CHECKPOINT_WITNESS.check(
      sql,
      'release:green:papercusp',
      24 * 60 * 60 * 1000,
    );

    expect(result).toEqual({
      occurred: false,
      evidence: 'no advanced/advanced-prefix pipeline_events row for install_slug=papercusp in the window',
    });
  });
});
