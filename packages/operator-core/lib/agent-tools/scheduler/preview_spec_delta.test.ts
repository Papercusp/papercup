import { describe, expect, it } from 'vitest';
import { resolvePreviewHarness } from './preview_spec_delta';

describe('resolvePreviewHarness — operator scope must not become a literal harness', () => {
  it('rejects an unscoped operator context instead of previewing an empty `*` lane', () => {
    expect(resolvePreviewHarness(undefined, null, '*')).toBeUndefined();
  });

  it('inherits a concrete ambient harness from an unscoped sentinel argument', () => {
    expect(resolvePreviewHarness('*', null, 'papercusp')).toBe('papercusp');
  });

  it('prefers a concrete stored scope over the operator-context sentinel', () => {
    expect(resolvePreviewHarness(undefined, 'papercusp', '*')).toBe('papercusp');
  });

  it('falls back from a stale wildcard stored scope to a concrete ambient harness', () => {
    expect(resolvePreviewHarness(undefined, '*', 'papercusp')).toBe('papercusp');
  });

  it('gives an explicit concrete harness precedence over stored and ambient scopes', () => {
    expect(resolvePreviewHarness('papercusp', 'other-harness', '*')).toBe('papercusp');
  });
});
