/**
 * local-backend-store — unit tests for the pure validation (SQL paths are exercised live by the
 * gateway:local_backend_* tools + local-backend-gateway.test.ts's pool-level coverage, mirroring
 * agent-facts/store.test.ts's split between pure-logic tests and live-SQL verify).
 */
import { describe, expect, it } from 'vitest';
import { validateLocalBackendInput } from './local-backend-store';

describe('validateLocalBackendInput', () => {
  const valid = { id: 'ornith', kind: 'llama-server', baseUrl: 'http://127.0.0.1:8081', models: ['ornith-35b'], maxConcurrent: 4 };

  it('accepts a valid registration', () => {
    expect(validateLocalBackendInput(valid)).toBeNull();
  });

  it('requires a non-empty id', () => {
    expect(validateLocalBackendInput({ ...valid, id: '' })).toMatch(/id is required/);
  });

  it('requires kind to be one of the known backend kinds', () => {
    expect(validateLocalBackendInput({ ...valid, kind: 'sglang' })).toMatch(/kind must be one of/);
  });

  it('requires baseUrl to be a valid http(s) URL', () => {
    expect(validateLocalBackendInput({ ...valid, baseUrl: '' })).toMatch(/baseUrl is required/);
    expect(validateLocalBackendInput({ ...valid, baseUrl: 'not a url' })).toMatch(/not a valid URL/);
    expect(validateLocalBackendInput({ ...valid, baseUrl: 'ftp://127.0.0.1' })).toMatch(/must be http\(s\)/);
  });

  it('requires models to be a non-empty array of strings', () => {
    expect(validateLocalBackendInput({ ...valid, models: [] })).toMatch(/models must be/);
    expect(validateLocalBackendInput({ ...valid, models: ['', 'x'] })).toMatch(/models must be/);
    expect(validateLocalBackendInput({ ...valid, models: undefined })).toMatch(/models must be/);
  });

  it('rejects a non-positive maxConcurrent when provided', () => {
    expect(validateLocalBackendInput({ ...valid, maxConcurrent: 0 })).toMatch(/maxConcurrent must be/);
    expect(validateLocalBackendInput({ ...valid, maxConcurrent: -1 })).toMatch(/maxConcurrent must be/);
  });

  it('maxConcurrent is optional', () => {
    const { maxConcurrent: _mc, ...rest } = valid;
    expect(validateLocalBackendInput(rest)).toBeNull();
  });

  // Lifecycle (migration 843 / plan on-demand-local-inference-lifecycle-2026-08-17 D-005).
  // These mirror the DB CHECK constraints; the DB is the real enforcement, but a caller deserves
  // a sentence rather than a raw constraint violation.

  it('lifecycle is optional, and omitting it is what keeps a pre-843 caller always-on', () => {
    expect(validateLocalBackendInput(valid)).toBeNull();
    expect(validateLocalBackendInput({ ...valid, lifecycle: 'always-on' })).toBeNull();
  });

  it('rejects an unknown lifecycle', () => {
    expect(validateLocalBackendInput({ ...valid, lifecycle: 'sometimes' })).toMatch(/lifecycle must be one of/);
  });

  it('rejects a non-positive idleTtlSec, but allows null (meaning: the reaper default)', () => {
    expect(validateLocalBackendInput({ ...valid, idleTtlSec: 0 })).toMatch(/idleTtlSec must be/);
    expect(validateLocalBackendInput({ ...valid, idleTtlSec: -30 })).toMatch(/idleTtlSec must be/);
    expect(validateLocalBackendInput({ ...valid, idleTtlSec: null })).toBeNull();
    expect(validateLocalBackendInput({ ...valid, idleTtlSec: 1800 })).toBeNull();
  });

  it('refuses on-demand without a unitName — an armed-looking backend nothing can actually stop', () => {
    expect(validateLocalBackendInput({ ...valid, lifecycle: 'on-demand' })).toMatch(/requires unitName/);
    expect(validateLocalBackendInput({ ...valid, lifecycle: 'on-demand', unitName: '   ' })).toMatch(/requires unitName/);
    expect(
      validateLocalBackendInput({ ...valid, lifecycle: 'on-demand', unitName: 'llama-ornith.service' }),
    ).toBeNull();
  });

  it('does not require a unitName for an always-on backend', () => {
    // The pairing matters: the requirement is conditional on lifecycle, not universal. A universal
    // unitName requirement would break every existing always-on registration.
    expect(validateLocalBackendInput({ ...valid, lifecycle: 'always-on', unitName: null })).toBeNull();
  });
});
