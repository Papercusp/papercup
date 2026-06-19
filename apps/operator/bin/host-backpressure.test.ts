import { describe, it, expect } from 'vitest';
import { decideShedding, type SheddingInput } from './host-backpressure';

const base: SheddingInput = {
  enabled: true,
  pressure: 'critical',
  path: '/api/foo',
  deferrableHeader: null,
  deferrablePaths: [],
};

describe('decideShedding', () => {
  it('does not shed when disabled (even a deferrable request under pressure)', () => {
    expect(decideShedding({ ...base, enabled: false, deferrableHeader: '1' }).shed).toBe(false);
  });

  it('does not shed when the loop is not critical', () => {
    expect(decideShedding({ ...base, pressure: 'ok', deferrableHeader: '1' }).shed).toBe(false);
    expect(decideShedding({ ...base, pressure: 'elevated', deferrableHeader: '1' }).shed).toBe(false);
  });

  it('does not shed unmarked / interactive traffic, even under critical pressure', () => {
    expect(decideShedding({ ...base }).shed).toBe(false);
  });

  it('sheds deferrable-header requests under critical pressure (default Retry-After 5s)', () => {
    const d = decideShedding({ ...base, deferrableHeader: '1' });
    expect(d.shed).toBe(true);
    if (d.shed) expect(d.retryAfterSec).toBe(5);
  });

  it('respects a custom retryAfterSec', () => {
    expect(decideShedding({ ...base, deferrableHeader: '1' }, 12)).toEqual({ shed: true, retryAfterSec: 12 });
  });

  it('sheds requests matching a configured deferrable path prefix', () => {
    expect(decideShedding({ ...base, path: '/api/telemetry/x', deferrablePaths: ['/api/telemetry'] }).shed).toBe(true);
  });

  it('treats falsey header values ("0"/"false") as NOT deferrable', () => {
    expect(decideShedding({ ...base, deferrableHeader: '0' }).shed).toBe(false);
    expect(decideShedding({ ...base, deferrableHeader: 'false' }).shed).toBe(false);
  });

  it('NEVER sheds protected health/liveness paths, even when marked deferrable', () => {
    expect(decideShedding({ ...base, path: '/api/health', deferrableHeader: '1' }).shed).toBe(false);
    expect(decideShedding({ ...base, path: '/api/health/deep', deferrableHeader: '1' }).shed).toBe(false);
  });
});
