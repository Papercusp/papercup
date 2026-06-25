/**
 * reduceBootstrapRows — the pure "ready"/driver reduction the dogfood banner +
 * setup-finish gate BOTH settle from (one interpretation of the sync rows).
 */
import { describe, it, expect } from 'vitest';
import {
  reduceBootstrapRows,
  bootstrapStepLabel,
  type BootstrapProgressRow,
} from './useDogfoodBootstrapProgress';

const row = (
  step: BootstrapProgressRow['step'],
  status: BootstrapProgressRow['status'],
  extra: { percent?: number; detail?: string } = {},
  ts = 1,
): BootstrapProgressRow => ({ step, status, ts, ...extra });

describe('reduceBootstrapRows', () => {
  it('empty → no rows, not ready, not in progress', () => {
    const p = reduceBootstrapRows([]);
    expect(p.hasRows).toBe(false);
    expect(p.ready).toBe(false);
    expect(p.inProgress).toBe(false);
    expect(p.activeStep).toBeUndefined();
  });

  it('clone running → in progress, active clone + percent/detail', () => {
    const p = reduceBootstrapRows([row('clone', 'running', { percent: 42, detail: 'downloading' })]);
    expect(p.inProgress).toBe(true);
    expect(p.ready).toBe(false);
    expect(p.activeStep).toBe('clone');
    expect(p.activePercent).toBe(42);
    expect(p.activeDetail).toBe('downloading');
  });

  it('clone done + submodules running → still in progress (NOT ready)', () => {
    const p = reduceBootstrapRows([
      row('clone', 'done'),
      row('submodules', 'running', { percent: 30, detail: '8/27 submodules' }, 2),
    ]);
    expect(p.ready).toBe(false);
    expect(p.inProgress).toBe(true);
    expect(p.activeStep).toBe('submodules');
    expect(p.activePercent).toBe(30);
  });

  it('clone done + submodules DONE → ready (fresh clone)', () => {
    const p = reduceBootstrapRows([row('clone', 'done'), row('submodules', 'done', {}, 2)]);
    expect(p.ready).toBe(true);
    expect(p.inProgress).toBe(false);
  });

  it('clone done + submodules SKIPPED → ready (local checkout)', () => {
    const p = reduceBootstrapRows([
      row('clone', 'done', { detail: 'local checkout' }),
      row('submodules', 'skipped', {}, 2),
    ]);
    expect(p.ready).toBe(true);
    expect(p.inProgress).toBe(false);
  });

  it('an error → hasError, not ready, not in progress', () => {
    const p = reduceBootstrapRows([
      row('clone', 'running', { percent: 10 }),
      row('clone', 'error', { detail: 'auth_required' }, 2),
    ]);
    expect(p.hasError).toBe(true);
    expect(p.ready).toBe(false);
    expect(p.inProgress).toBe(false);
  });

  it('a clone network_timeout error → hasError AND networkError (EI-3548)', () => {
    const p = reduceBootstrapRows([
      row('clone', 'running', { percent: 0 }),
      row('clone', 'error', { detail: 'network_timeout' }, 2),
    ]);
    expect(p.hasError).toBe(true);
    expect(p.networkError).toBe(true);
  });

  it('an auth_required error → hasError but NOT networkError', () => {
    const p = reduceBootstrapRows([row('clone', 'error', { detail: 'auth_required' })]);
    expect(p.hasError).toBe(true);
    expect(p.networkError).toBe(false);
  });

  it('a detail-less error → hasError but NOT networkError (no false positive)', () => {
    const p = reduceBootstrapRows([row('submodules', 'error')]);
    expect(p.hasError).toBe(true);
    expect(p.networkError).toBe(false);
  });

  it('submodules done but a clone error present → NOT ready (error wins)', () => {
    const p = reduceBootstrapRows([
      row('clone', 'error', {}, 1),
      row('submodules', 'done', {}, 2),
    ]);
    expect(p.ready).toBe(false);
    expect(p.hasError).toBe(true);
  });

  it('latest row per step wins (coalesced running rows)', () => {
    const p = reduceBootstrapRows([
      row('clone', 'running', { percent: 10 }, 1),
      row('clone', 'running', { percent: 90 }, 2),
    ]);
    expect(p.clone?.percent).toBe(90);
    expect(p.activePercent).toBe(90);
  });
});

describe('bootstrapStepLabel', () => {
  it('labels each step', () => {
    expect(bootstrapStepLabel('clone')).toMatch(/Downloading/);
    expect(bootstrapStepLabel('submodules')).toMatch(/submodules/i);
    expect(bootstrapStepLabel(undefined)).toMatch(/Setting up/);
  });
});
