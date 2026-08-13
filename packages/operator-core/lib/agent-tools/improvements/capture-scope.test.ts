import { describe, expect, it } from 'vitest';
import { resolveCaptureScope } from './capture-scope';

describe('resolveCaptureScope', () => {
  it('normalizes the bare harness alias to the canonical pot scope', () => {
    expect(resolveCaptureScope({ harness: 'papercusp' })).toEqual({ scope: 'harness:papercusp' });
  });

  it('does not double-prefix a harness alias that is already spelled harness:<slug>', () => {
    expect(resolveCaptureScope({ harness: 'harness:papercusp' })).toEqual({ scope: 'harness:papercusp' });
  });

  it('passes a scope through untouched when no harness alias is supplied', () => {
    expect(resolveCaptureScope({ scope: 'harness:foo' })).toEqual({ scope: 'harness:foo' });
    // capture-core auto-homes a non-pot scope to the platform Pot; nothing to reconcile.
    expect(resolveCaptureScope({ scope: 'operator' })).toEqual({ scope: 'operator' });
  });

  it('accepts the same Pot named twice, however it is spelled (EI-20309391070582534)', () => {
    // The exact filing: scope='papercusp' + harness='papercusp' used to throw.
    expect(resolveCaptureScope({ scope: 'papercusp', harness: 'papercusp' })).toEqual({
      scope: 'harness:papercusp',
    });
    expect(resolveCaptureScope({ scope: 'harness:papercusp', harness: 'papercusp' })).toEqual({
      scope: 'harness:papercusp',
    });
    expect(resolveCaptureScope({ scope: ' harness:papercusp ', harness: ' papercusp ' })).toEqual({
      scope: 'harness:papercusp',
    });
  });

  it('resolves-and-warns instead of bouncing a subject-area scope beside a harness alias', () => {
    // The other three filings of this same class, all lost captures before the fix.
    for (const scope of ['coordination', 'papercusp-su', 'papercusp-workspace']) {
      const res = resolveCaptureScope({ scope, harness: 'papercusp' });
      expect(res.conflict).toBeUndefined();
      expect(res.scope).toBe('harness:papercusp');
      expect(res.warning).toContain(scope);
      // The warning must say where the item actually landed, never just that the
      // value was wrong — a silent supersede is the failure being replaced.
      expect(res.warning).toContain('harness:papercusp');
    }
  });

  it('still refuses two DIFFERENT Pots — the one hazard the guard exists for', () => {
    const res = resolveCaptureScope({ scope: 'harness:one', harness: 'two' });
    expect(res.scope).toBeUndefined();
    expect(res.conflict).toMatch(/conflicting capture scopes/);
    expect(res.conflict).toContain('one');
    expect(res.conflict).toContain('two');
  });

  it('treats blank/whitespace values as absent rather than as a Pot name', () => {
    expect(resolveCaptureScope({ scope: '   ', harness: 'papercusp' })).toEqual({ scope: 'harness:papercusp' });
    expect(resolveCaptureScope({ scope: 'harness:foo', harness: '  ' })).toEqual({ scope: 'harness:foo' });
    expect(resolveCaptureScope({})).toEqual({ scope: undefined });
  });
});
