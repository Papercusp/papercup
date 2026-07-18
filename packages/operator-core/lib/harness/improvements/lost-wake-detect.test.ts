/**
 * lost-wake-detect.test.ts (watchdog wiring) — EI-10869. Confirms the collector-facing map
 * pages ONLY convicted findings, never an unwitnessed suspect (the false-positive-machine
 * guard, at the boundary that actually reaches the improvement queue).
 *
 * Run: cd packages/operator-core && npx vitest run lib/harness/improvements/lost-wake-detect.test.ts
 */
import { describe, it, expect } from 'vitest';
import { detectLostWakes } from './lost-wake-detect';
import type { LostWakeFinding } from '../../events/await/lost-wake-detect';

const convicted: LostWakeFinding = {
  eventKey: 'release:green:papercusp',
  fired: 0,
  timedOut: 88,
  settled: 88,
  pctRealFire: 0,
  verdict: 'convicted',
  witness: { name: 'green-checkpoint-pipeline-events', owner: 'apps/operator/lib/release/green-checkpoint.ts', evidence: '3 advanced/up-to-date rows in the window' },
};

const suspect: LostWakeFinding = {
  eventKey: 'overwatch:surface-landed',
  fired: 0,
  timedOut: 14,
  settled: 14,
  pctRealFire: 0,
  verdict: 'suspect',
  witness: null,
};

describe('detectLostWakes', () => {
  it('pages a convicted finding as a major bug signal', () => {
    const signals = detectLostWakes([convicted]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: 'lost-wake',
      key: 'lost-wake:release:green:papercusp',
      severity: 'major',
      kind: 'bug',
      scope: 'operator',
    });
    expect(signals[0]?.body).toContain('green-checkpoint-pipeline-events');
  });

  it('never pages an unwitnessed suspect', () => {
    const signals = detectLostWakes([suspect]);
    expect(signals).toHaveLength(0);
  });

  it('mixed input pages only the convicted entries', () => {
    const signals = detectLostWakes([convicted, suspect]);
    expect(signals.map((s) => s.key)).toEqual(['lost-wake:release:green:papercusp']);
  });

  it('empty input pages nothing', () => {
    expect(detectLostWakes([])).toHaveLength(0);
  });
});
