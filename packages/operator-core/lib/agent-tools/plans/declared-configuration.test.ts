import { describe, expect, it } from 'vitest';
import {
  DECLARED_CONFIGURATION_FINGERPRINT_PREFIX,
  captureConfigurationSnapshot,
  declaredConfigurationFingerprint,
  evidenceConfigurationFingerprint,
  judgeDeclaredConfiguration,
  parseProductionConfiguration,
  readConfigurationSnapshot,
} from './declared-configuration';

const DECLARED = { flags: { 'papercusp-loops': true }, env: { PAPERCUSP_SEARCH_MODE: 'hybrid' } };

function runSnapshot(flags: Record<string, unknown>, env: Record<string, string | undefined>) {
  return captureConfigurationSnapshot({ flags, env });
}

describe('declared configuration — parse (AUTO-BAR-R-11-P-011)', () => {
  it('treats an absent or empty declaration as no declaration', () => {
    expect(parseProductionConfiguration(undefined)).toBeNull();
    expect(parseProductionConfiguration(null)).toBeNull();
    expect(parseProductionConfiguration({ flags: {}, env: {} })).toBeNull();
  });

  it('accepts flags and env and refuses malformed declarations loudly', () => {
    expect(parseProductionConfiguration(DECLARED)).toEqual(DECLARED);
    expect(() => parseProductionConfiguration('on')).toThrow(/must be an object/);
    expect(() => parseProductionConfiguration({ flags: { x: 'yes' } })).toThrow(/must be a boolean/);
    expect(() => parseProductionConfiguration({ env: { PAPERCUSP_X: 1 } })).toThrow(/must be a string/);
    expect(() => parseProductionConfiguration({ env: { HOME: '/root' } })).toThrow(/not a recorded env var/);
    expect(() => parseProductionConfiguration({ flag: { x: true } })).toThrow(/unknown keys: flag/);
  });
});

describe('declared configuration — snapshot (SPEC-P-011-RUNNER-CAPTURE)', () => {
  it('records resolved flags and hashes only in-scope env values, never raw values', () => {
    const snapshot = runSnapshot(
      { 'papercusp-loops': true, 'not-a-boolean': 'x' },
      { PAPERCUSP_SEARCH_MODE: 'hybrid', NODE_ENV: 'test', GITHUB_TOKEN: 'secret', HOME: '/home/x' },
    );
    expect(snapshot.flags).toEqual({ 'papercusp-loops': true });
    expect(Object.keys(snapshot.envSha256).sort()).toEqual(['NODE_ENV', 'PAPERCUSP_SEARCH_MODE']);
    expect(JSON.stringify(snapshot)).not.toContain('hybrid');
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });

  it('round-trips through execution_details and rejects malformed snapshots', () => {
    const snapshot = runSnapshot({ a: false }, { NODE_ENV: 'test' });
    expect(readConfigurationSnapshot({ configuration: snapshot })).toEqual(snapshot);
    expect(readConfigurationSnapshot(null)).toBeNull();
    expect(readConfigurationSnapshot({})).toBeNull();
    expect(readConfigurationSnapshot({ configuration: { ...snapshot, schemaVersion: 2 } })).toBeNull();
    expect(readConfigurationSnapshot({ configuration: { ...snapshot, flags: { a: 'on' } } })).toBeNull();
  });
});

describe('declared configuration — bind-time judgement (AUTO-BAR-R-11-P-011)', () => {
  it('accepts a run whose snapshot matches every declared key, ignoring undeclared keys', () => {
    const snapshot = runSnapshot(
      { 'papercusp-loops': true, 'other-flag': false },
      { PAPERCUSP_SEARCH_MODE: 'hybrid', NODE_ENV: 'test' },
    );
    const verdict = judgeDeclaredConfiguration(DECLARED, snapshot);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.fingerprint).toBe(declaredConfigurationFingerprint(DECLARED));
    expect(declaredConfigurationFingerprint(DECLARED).startsWith(DECLARED_CONFIGURATION_FINGERPRINT_PREFIX)).toBe(true);
  });

  it('refuses a run with no snapshot as fingerprint-missing', () => {
    const verdict = judgeDeclaredConfiguration(DECLARED, null);
    expect(verdict).toMatchObject({ ok: false, code: 'declared_configuration_fingerprint_missing', fingerprint: null });
  });

  it('refuses a run whose flag differs, and names the differing key', () => {
    const snapshot = runSnapshot({ 'papercusp-loops': false }, { PAPERCUSP_SEARCH_MODE: 'hybrid' });
    expect(judgeDeclaredConfiguration(DECLARED, snapshot)).toMatchObject({
      ok: false,
      code: 'declared_configuration_fingerprint_mismatch',
      differing: ['flag:papercusp-loops'],
    });
  });

  it('refuses a run whose env value differs or is absent', () => {
    const differs = runSnapshot({ 'papercusp-loops': true }, { PAPERCUSP_SEARCH_MODE: 'lexical' });
    const absent = runSnapshot({ 'papercusp-loops': true }, {});
    for (const snapshot of [differs, absent]) {
      expect(judgeDeclaredConfiguration(DECLARED, snapshot)).toMatchObject({
        ok: false,
        code: 'declared_configuration_fingerprint_mismatch',
        differing: ['env:PAPERCUSP_SEARCH_MODE'],
      });
    }
  });

  it('distinguishes a declared flag absent from the run from one recorded false', () => {
    const declared = { flags: { 'papercusp-loops': false } };
    const absent = runSnapshot({}, {});
    const recordedFalse = runSnapshot({ 'papercusp-loops': false }, {});
    expect(evidenceConfigurationFingerprint(absent, declared)).not.toBe(declaredConfigurationFingerprint(declared));
    expect(evidenceConfigurationFingerprint(recordedFalse, declared)).toBe(declaredConfigurationFingerprint(declared));
  });
});
