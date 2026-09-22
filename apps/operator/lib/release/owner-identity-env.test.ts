/**
 * The loader that fills PAPERCUSP_RELEASE_OWNER_NAME / _EMAIL from the owner's
 * `~/.papercusp/release-identity.env` for the release CLIs.
 *
 * Every test here injects BOTH the env object and the file reader. That is not
 * fastidiousness: the subject reads the real home directory by default, so a test
 * that let it do so would pass or fail according to whether the developer running it
 * happens to have that file — the exact environment-dependent verdict this loader was
 * deliberately kept out of `identityLiterals()` to avoid.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_ENV_PATH_ENV,
  OWNER_IDENTITY_KEYS,
  defaultIdentityEnvPath,
  describeOwnerIdentityLoad,
  loadOwnerIdentityEnv,
} from './owner-identity-env';

const NAME = 'PAPERCUSP_RELEASE_OWNER_NAME';
const EMAIL = 'PAPERCUSP_RELEASE_OWNER_EMAIL';

/** A stand-in owner. Never the real one — writing that here would be the leak. */
const FIXTURE = `${NAME}=Fixture Owner\n${EMAIL}=fixture@example.invalid\n`;

describe('loadOwnerIdentityEnv', () => {
  it('fills an unset owner name from the config file', () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadOwnerIdentityEnv({ env, filePath: '/cfg', readFile: () => FIXTURE });

    expect(r.loaded).toBe(true);
    expect(env[NAME]).toBe('Fixture Owner');
    expect(env[EMAIL]).toBe('fixture@example.invalid');
    expect(r.filled).toEqual([NAME, EMAIL]);
  });

  it('NEVER overrides a value the environment already carries', () => {
    // The whole point of the precedence: a caller that exported the variable for this
    // one run (CI, a container, a different owner) must keep what it asked for.
    const env: NodeJS.ProcessEnv = { [NAME]: 'Explicit Wins' };
    const r = loadOwnerIdentityEnv({ env, filePath: '/cfg', readFile: () => FIXTURE });

    expect(env[NAME]).toBe('Explicit Wins');
    expect(r.alreadySet).toContain(NAME);
    expect(r.filled).not.toContain(NAME);
    // …while still filling the gap beside it.
    expect(env[EMAIL]).toBe('fixture@example.invalid');
    expect(r.filled).toEqual([EMAIL]);
  });

  it('does not read the file at all when both keys are already set', () => {
    const readFile = vi.fn(() => FIXTURE);
    const env: NodeJS.ProcessEnv = { [NAME]: 'A', [EMAIL]: 'b@example.invalid' };

    const r = loadOwnerIdentityEnv({ env, filePath: '/cfg', readFile });

    expect(readFile).not.toHaveBeenCalled();
    expect(r.loaded).toBe(true);
    expect(r.filled).toEqual([]);
  });

  it('treats a missing file as a reportable fact, not an error', () => {
    // The gate's own fail-closed branch is what refuses to certify. If this threw
    // instead, "I could not read config" and "I cannot certify" would collapse into
    // one indistinguishable failure — the conflation this subsystem exists to prevent.
    const env: NodeJS.ProcessEnv = {};
    const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });

    const r = loadOwnerIdentityEnv({
      env,
      filePath: '/cfg',
      readFile: () => {
        throw enoent;
      },
    });

    expect(r.loaded).toBe(false);
    expect(r.reason).toBe('no-file');
    expect(r.filled).toEqual([]);
    expect(env[NAME]).toBeUndefined();
  });

  it('reports an unreadable file distinctly from an absent one', () => {
    const env: NodeJS.ProcessEnv = {};
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    const r = loadOwnerIdentityEnv({
      env,
      filePath: '/cfg',
      readFile: () => {
        throw eacces;
      },
    });

    expect(r.loaded).toBe(false);
    expect(r.reason).toBe('unreadable');
    expect(r.error).toMatch(/permission denied/);
  });

  it('sets ONLY allowlisted keys, ignoring anything else in the file', () => {
    // This file is owner-provisioned config. A `. file` that adopts whatever it
    // contains is how a stray line silently changes the behaviour of a publish.
    const env: NodeJS.ProcessEnv = {};
    const r = loadOwnerIdentityEnv({
      env,
      filePath: '/cfg',
      readFile: () => `${FIXTURE}AWS_SECRET_ACCESS_KEY=should-not-be-adopted\nPATH=/evil\n`,
    });

    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBeUndefined();
    expect(r.filled.every((k) => (OWNER_IDENTITY_KEYS as readonly string[]).includes(k))).toBe(true);
  });

  it('ignores a present-but-empty value rather than resolving a blank name', () => {
    // A blank name literal is the failure this whole subsystem guards: it leaves
    // hasOwnerNameLiteral() able to read TRUE while detecting nothing.
    const env: NodeJS.ProcessEnv = {};
    const r = loadOwnerIdentityEnv({ env, filePath: '/cfg', readFile: () => `${NAME}=\n` });

    expect(env[NAME]).toBeUndefined();
    expect(r.filled).toEqual([]);
  });

  it('treats a whitespace-only environment value as unset and fills it', () => {
    const env: NodeJS.ProcessEnv = { [NAME]: '   ' };
    loadOwnerIdentityEnv({ env, filePath: '/cfg', readFile: () => FIXTURE });

    expect(env[NAME]).toBe('Fixture Owner');
  });
});

describe('defaultIdentityEnvPath', () => {
  it('honours an explicit override', () => {
    expect(defaultIdentityEnvPath({ [IDENTITY_ENV_PATH_ENV]: '/tmp/custom.env' }, '/home/x')).toBe(
      '/tmp/custom.env',
    );
  });

  it('falls back to the papercusp config directory under home', () => {
    expect(defaultIdentityEnvPath({}, '/home/x')).toBe('/home/x/.papercusp/release-identity.env');
  });
});

describe('describeOwnerIdentityLoad', () => {
  it('names the KEYS and the PATH but never the VALUES', () => {
    // The values are the owner's real name and email. A loader that echoes them into a
    // build log — which gets pasted into work items — is the same leak by another route.
    const env: NodeJS.ProcessEnv = {};
    const r = loadOwnerIdentityEnv({ env, filePath: '/cfg/id.env', readFile: () => FIXTURE });
    const line = describeOwnerIdentityLoad(r);

    expect(line).toContain(NAME);
    expect(line).toContain('/cfg/id.env');
    expect(line).not.toContain('Fixture Owner');
    expect(line).not.toContain('fixture@example.invalid');
  });

  it('says plainly when there was no file to read', () => {
    const line = describeOwnerIdentityLoad({
      path: '/cfg/id.env',
      loaded: false,
      reason: 'no-file',
      filled: [],
      alreadySet: [],
    });
    expect(line).toMatch(/no \/cfg\/id\.env/);
  });
});
