/**
 * Coverage for the kickoff-kind allowlist on the console-launch route.
 *
 * The validator itself lives next to the route as a small private
 * helper; we test its behavior via a re-export so the surface stays
 * private. Per `plans-newbutton-and-subharness-scope-2026-05-25` P-008
 * + D-003.
 */
import { describe, expect, it } from 'vitest';

// The kickoff-kind allowlist is a shared lib helper (one source for every
// launch surface). P-032 lifted it out of the console-launch route.
import { validateKickoffKind as validateKickoff } from '../kickoff-kind';

describe('validateKickoff', () => {
  it('passes null through as null (no kickoff requested)', () => {
    const v = validateKickoff(null);
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.value).toBeNull();
  });

  it('passes undefined through as null', () => {
    const v = validateKickoff(undefined);
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.value).toBeNull();
  });

  it('treats { kind: "" } as no kickoff (lenient)', () => {
    const v = validateKickoff({ kind: '   ' });
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.value).toBeNull();
  });

  it('accepts the allowlisted "new-plan" kind', () => {
    const v = validateKickoff({ kind: 'new-plan' });
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.value).toEqual({ kind: 'new-plan' });
  });

  it('rejects unknown kinds with a helpful message', () => {
    const v = validateKickoff({ kind: 'exfiltrate-secrets' });
    expect(v.kind).toBe('error');
    if (v.kind === 'error') {
      expect(v.error).toMatch(/exfiltrate-secrets/);
      expect(v.error).toMatch(/allowlist/);
    }
  });

  it('rejects empty-string spam after trim with a "not in allowlist" error only for actual non-empty bogus kinds', () => {
    const v = validateKickoff({ kind: 'x' });
    expect(v.kind).toBe('error');
  });
});
