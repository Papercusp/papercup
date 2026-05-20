/**
 * Operator-side routing tests for context-aware docs:* tools.
 *
 * The engine package tests cover buildOutline/getDocs/searchDocs
 * against a mock DocSource. These tests cover the operator-side
 * branching: which adapter does each tool pick given ctx.harnessSlug?
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/lib/harness-registry');
});

describe('docs:outline resolveAdapter', () => {
  it('falls back to engineering when no harnessSlug', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const mod = await import('../outline');
    const result = await mod.resolveAdapter(undefined);
    expect(result.surface).toBe('engineering');
    expect(result.scope).toBe('_engineering');
    expect(result.error).toBeUndefined();
  });

  it('resolves to harness adapter when slug is registered', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/harness-fixture' }],
      })),
    }));
    const mod = await import('../outline');
    const result = await mod.resolveAdapter('sheets');
    expect(result.surface).toBe('harness');
    expect(result.scope).toBe('sheets');
    expect(result.error).toBeUndefined();
  });

  it('returns harness_not_registered error when slug is unknown', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const mod = await import('../outline');
    const result = await mod.resolveAdapter('does-not-exist');
    expect(result.error).toEqual({ code: 'harness_not_registered', slug: 'does-not-exist' });
    expect(result.surface).toBe('engineering');
  });
});

describe('docs:get resolveAdapter', () => {
  it('falls back to engineering when no harnessSlug', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const mod = await import('../get');
    const result = await mod.resolveAdapter(undefined);
    expect(result.surface).toBe('engineering');
    expect(result.error).toBeUndefined();
  });

  it('resolves to harness adapter when slug is registered', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/harness-fixture' }],
      })),
    }));
    const mod = await import('../get');
    const result = await mod.resolveAdapter('sheets');
    expect(result.surface).toBe('harness');
  });

  it('returns harness_not_registered error when slug is unknown', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const mod = await import('../get');
    const result = await mod.resolveAdapter('does-not-exist');
    expect(result.error).toEqual({ code: 'harness_not_registered', slug: 'does-not-exist' });
  });
});

describe('docs:search resolveAdapter', () => {
  it('falls back to engineering when no harnessSlug', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const mod = await import('../search');
    const result = await mod.resolveAdapter(undefined);
    expect(result.surface).toBe('engineering');
  });

  it('resolves to harness adapter when slug is registered', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({
        projects: [{ slug: 'sheets', path: '/tmp/harness-fixture' }],
      })),
    }));
    const mod = await import('../search');
    const result = await mod.resolveAdapter('sheets');
    expect(result.surface).toBe('harness');
  });

  it('returns harness_not_registered error when slug is unknown', async () => {
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    const mod = await import('../search');
    const result = await mod.resolveAdapter('does-not-exist');
    expect(result.error).toEqual({ code: 'harness_not_registered', slug: 'does-not-exist' });
  });
});
