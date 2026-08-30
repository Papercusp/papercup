/**
 * kasmvnc-credentials.ts — mint a sandbox desktop's per-session watch/takeover
 * credentials (P-012 / D-020).
 *
 * Separated from the pure `x-server-backend.ts` because this half touches the
 * filesystem and spawns `kasmvncpasswd`; keeping the argv construction pure over
 * there is what lets the security mapping be unit-tested without a KasmVNC install.
 *
 * WHY PER-SESSION AND RANDOM, restated because it is easy to "simplify" away: these
 * are not user passwords and no human ever types one. They exist so that the
 * loopback listener is not an open door to anything already running on the host.
 * D-020 records honestly that the BYOC lane degrades the local path's "no listener,
 * ever" to "loopback-only listener behind a ticket gate"; this is the residue that
 * closes — a process that reaches the loopback port still has nothing to present.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  KASMVNC_CONTROL_USER,
  KASMVNC_VIEW_USER,
  kasmvncPasswordArgv,
} from './x-server-backend';

export interface KasmvncSessionCredentials {
  /** Path to the kasmvncpasswd file the server is started against. */
  passwordFile: string;
  /** View-only user: pixels, no input. What a `watch` viewer authenticates as. */
  view: { user: string; secret: string };
  /** Read+write user: pixels and input. What an audited `takeover` authenticates as. */
  control: { user: string; secret: string };
  /** Remove the credential file. Idempotent. */
  destroy: () => void;
}

/** 32 bytes of CSPRNG entropy, base64url — never a derived or guessable value. */
function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Create `passwordFile` holding a view-only and a read/write user with fresh random
 * secrets.
 *
 * The file is created 0600 BEFORE `kasmvncpasswd` writes into it and re-asserted 0600
 * after. Order matters: creating it and then tightening the mode leaves a window in
 * which the secrets exist at the umask's permissions, and on a multi-tenant workspace
 * host that window is the whole vulnerability.
 */
export function mintKasmvncSessionCredentials(input: {
  passwordFile: string;
  /** Override for tests / an extracted-tree install not on PATH. */
  kasmvncpasswdPath?: string;
}): KasmvncSessionCredentials {
  const bin = input.kasmvncpasswdPath ?? 'kasmvncpasswd';
  const view = { user: KASMVNC_VIEW_USER, secret: newSecret() };
  const control = { user: KASMVNC_CONTROL_USER, secret: newSecret() };

  mkdirSync(dirname(input.passwordFile), { recursive: true, mode: 0o700 });

  const write = (user: string, secret: string, mode: 'view' | 'control'): void => {
    const argv = kasmvncPasswordArgv({ user, passwordFile: input.passwordFile, mode });
    // kasmvncpasswd prompts twice for the password and reads them from stdin.
    const res = spawnSync(bin, argv, {
      input: `${secret}\n${secret}\n`,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (res.status !== 0) {
      throw new Error(
        `kasmvnc-credentials — ${bin} ${argv.join(' ')} failed (status ${res.status}): ` +
          `${res.stderr ?? ''}`.trim(),
      );
    }
    // Re-assert after every write: kasmvncpasswd creates the file itself on the first
    // call, at whatever the process umask implies.
    try {
      chmodSync(input.passwordFile, 0o600);
    } catch {
      /* the write above already failed loudly if the file is absent */
    }
  };

  write(view.user, view.secret, 'view');
  write(control.user, control.secret, 'control');

  return {
    passwordFile: input.passwordFile,
    view,
    control,
    destroy: () => {
      try {
        rmSync(input.passwordFile, { force: true });
      } catch {
        /* best-effort: a leaked 0600 file is bounded by the session directory's own teardown */
      }
    },
  };
}
