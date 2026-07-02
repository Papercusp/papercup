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
});
