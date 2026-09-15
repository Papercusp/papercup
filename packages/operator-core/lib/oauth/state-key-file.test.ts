/**
 * Coverage for `ensureOAuthStateKeyFile` — the durable half of WI-10001496.
 *
 * state.test.ts covers sign/verify and simulates a sibling worker by dropping
 * the in-process key cache AFTER the key file already exists. That leaves the
 * deploy-time case untested: a cold boot where all N SO_REUSEPORT workers race
 * this path from NOTHING. That race is where the original split-key bug bites,
 * so it is the case that has to be exercised with real concurrency.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// state.ts imports getOrgPg from this SUBPATH at module scope. Nothing here
// calls it, but mocking mirrors state.test.ts and keeps the real Drizzle
// construct (and its live pool) out of the unit lane.
vi.mock('@papercusp/db-org/connection', async (orig) => ({
  ...((await orig()) as object),
  getOrgPg: () => ({ sql: () => Promise.resolve([]), db: {} }),
}));

import { ensureOAuthStateKeyFile } from './state';

// Overridable so scripts/mutation-probe.sh can point the racing children at a
// HISTORICAL snapshot of state.ts and prove this arm is actually falsifiable,
// without ever mutating the tracked file (CLAUDE.md tier 2). Defaults to the
// real module, so an ordinary run is unchanged.
function resolveStateModule(): string {
  const raw = process.env.PAPERCUSP_OAUTH_STATE_MODULE;
  if (!raw) return fileURLToPath(new URL('./state.ts', import.meta.url));
  if (/\.m?ts$/.test(raw)) return raw;

  // mutation-probe.sh writes its frozen snapshots WITHOUT a file extension
  // (/tmp/mutation-probe.XXXX/snapshot-run-1). tsx decides whether to strip
  // types by extension, so an extensionless file is handed to Node's plain-JS
  // loader and dies at `const STATE_VERSION = 1 as const` with
  // "SyntaxError: Unexpected identifier 'as'" — on BOTH the current and the
  // historical leg, which the probe can only report as verdict=harness-error.
  // That is an UNDETERMINED result, and it reads deceptively like a real red.
  //
  // Re-home the snapshot with a .mts extension:
  //   - under the repo (not /tmp) so state.ts's `@papercusp/db-org/connection`
  //     import still resolves by the normal node_modules walk-up;
  //   - inside .papercusp/scratch/, which .gitignore:187 covers, so git-sync
  //     cannot sweep the copy into a commit (CLAUDE.md tier 2: never mutate,
  //     and never leave a sweepable artifact in the tracked tree);
  //   - .mts, not .ts, because that dir has no package.json declaring
  //     "type":"module", so a bare .ts would be compiled as CJS.
  const scratch = fileURLToPath(new URL('../../../../.papercusp/scratch/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const dest = join(scratch, `oauth-state-probe-${process.pid}-${Date.now()}.mts`);
  writeFileSync(dest, readFileSync(raw, 'utf8'));
  return dest;
}

const STATE_MODULE = resolveStateModule();
const TSX = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url));

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'papercusp-oauth-keyfile-'));
}

describe('ensureOAuthStateKeyFile', () => {
  it('publishes a non-empty key at mode 0600', () => {
    const path = join(freshDir(), 'oauth-state-key');
    const key = ensureOAuthStateKeyFile(path);

    expect(key).not.toBe('');
    expect(readFileSync(path, 'utf8').trim()).toBe(key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('adopts an existing key instead of overwriting it', () => {
    const path = join(freshDir(), 'oauth-state-key');
    const incumbent = 'incumbent-key-that-siblings-already-signed-under';
    writeFileSync(path, `${incumbent}\n`, { mode: 0o600 });

    // Keeping our own here would mean signing under a key no sibling holds.
    expect(ensureOAuthStateKeyFile(path)).toBe(incumbent);
    expect(readFileSync(path, 'utf8').trim()).toBe(incumbent);
  });

  it('is idempotent — a second call returns the same key', () => {
    const path = join(freshDir(), 'oauth-state-key');
    expect(ensureOAuthStateKeyFile(path)).toBe(ensureOAuthStateKeyFile(path));
  });

  it('heals a stale empty file rather than adopting an unusable key', () => {
    const path = join(freshDir(), 'oauth-state-key');
    writeFileSync(path, '   \n', { mode: 0o600 });

    const key = ensureOAuthStateKeyFile(path);
    expect(key).not.toBe('');
    expect(readFileSync(path, 'utf8').trim()).toBe(key);
  });

  it('tightens a key file left readable beyond its owner', () => {
    const path = join(freshDir(), 'oauth-state-key');
    writeFileSync(path, 'a-previously-world-readable-key\n', { mode: 0o644 });

    ensureOAuthStateKeyFile(path);
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

/**
 * The real instrument. N processes — no shared memory, one filesystem, released
 * from a barrier together — is what a forked SO_REUSEPORT worker fleet actually
 * is. Every worker must end up holding the SAME key as every other AND as the
 * file on disk; one divergent worker is the production symptom (a login that
 * fails `bad-signature` because the callback landed on a worker that signed
 * under a different key).
 */
const WORKERS = 8;
const CHILD_TIMEOUT_MS = 60_000;

/** Runs `body` in WORKERS processes released simultaneously; returns their stdout. */
async function raceInChildProcesses(body: string, keyPath: string): Promise<string[]> {
  const dir = freshDir();
  const script = join(dir, 'child.mts');
  const goPath = join(dir, 'go');

  // .mts: the temp dir has no package.json declaring "type":"module", so a bare
  // .ts would be compiled as CJS and reject ESM syntax under tsx.
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';
     import { randomBytes } from 'node:crypto';
     import { ensureOAuthStateKeyFile } from ${JSON.stringify(STATE_MODULE)};
     const keyPath = process.argv[2]!;
     const goPath = process.argv[3]!;
     const deadline = Date.now() + 30_000;
     while (!existsSync(goPath) && Date.now() < deadline) { /* spin to the barrier */ }
     process.stdout.write(${body});
    `,
  );

  const children = Array.from({ length: WORKERS }, () => {
    const child = spawn(TSX, [script, keyPath, goPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise<string>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('child timed out before reaching the barrier'));
      }, CHILD_TIMEOUT_MS);
      child.stdout.on('data', (d) => (out += String(d)));
      child.stderr.on('data', (d) => (err += String(d)));
      child.on('error', reject);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`child exited ${code}: ${err}`));
        else resolve(out.trim());
      });
    });
  });

  // Let every child boot tsx and reach the spin, then release them together.
  await new Promise((r) => setTimeout(r, 4_000));
  writeFileSync(goPath, 'go');
  return Promise.all(children);
}

describe('ensureOAuthStateKeyFile under real concurrency', () => {
  it(
    'has a harness that can DETECT divergence (calibration — must not be vacuous)',
    async () => {
      // Deliberately per-process keys: this is the OLD behaviour's signature.
      // If this arm does not diverge, the convergence assertion below proves
      // nothing and the whole test is theatre.
      const keyPath = join(freshDir(), 'oauth-state-key');
      const keys = await raceInChildProcesses(`randomBytes(32).toString('base64')`, keyPath);

      expect(keys).toHaveLength(WORKERS);
      expect(new Set(keys).size).toBeGreaterThan(1);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );

  it(
    'converges every racing worker on one key when the file starts ABSENT',
    async () => {
      const keyPath = join(freshDir(), 'oauth-state-key');
      expect(existsSync(keyPath)).toBe(false);

      const keys = await raceInChildProcesses(`ensureOAuthStateKeyFile(keyPath)`, keyPath);

      expect(keys).toHaveLength(WORKERS);
      expect(keys.every((k) => k !== '')).toBe(true);
      // The property: one key across the fleet, and it is the one on disk.
      expect(new Set(keys).size).toBe(1);
      expect(readFileSync(keyPath, 'utf8').trim()).toBe(keys[0]);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );

  /**
   * The DETERMINISTIC falsifier. The convergence arm above is a timing lottery:
   * the pre-fix window (between `openSync(path,'wx')` publishing an empty file
   * and the `writeSync` that fills it) is microseconds wide, and 8 workers x one
   * trial measurably does NOT land in it — scripts/mutation-probe.sh historical
   * mode scored that arm `verdict=survived` against the real pre-fix source, i.e.
   * it does not constrain the bug at all.
   *
   * This arm removes the luck. The two implementations differ OBSERVABLY on a
   * key that arrives while the file is empty: the repair waits EMPTY_KEY_GRACE_MS
   * (50ms) and re-reads, so it ADOPTS a sibling's key; the pre-fix code rmSync()s
   * the empty file immediately and returns a key of its own while disk holds the
   * sibling's — which is precisely the split key that makes a callback landing on
   * another worker fail `bad-signature`.
   *
   * The subject runs in a CHILD on purpose: the parent imports the real ./state,
   * so a parent-side assertion would test current code under both probe legs and
   * silently report SURVIVED again.
   */
  it(
    'adopts a sibling key that lands INSIDE the empty-file grace window',
    async () => {
      const dir = freshDir();
      const keyPath = join(dir, 'oauth-state-key');
      const goPath = join(dir, 'go');
      const siblingKey = 'sibling-key-published-during-the-empty-window';

      // Exactly the state the pre-fix code left behind mid-publish: the path
      // EXISTS (so an arriving worker sees EEXIST) but carries no key yet.
      writeFileSync(keyPath, '', { mode: 0o600 });

      const script = join(dir, 'subject.mts');
      writeFileSync(
        script,
        `import { existsSync } from 'node:fs';
         import { ensureOAuthStateKeyFile } from ${JSON.stringify(STATE_MODULE)};
         const keyPath = process.argv[2]!;
         const goPath = process.argv[3]!;
         const deadline = Date.now() + 30_000;
         while (!existsSync(goPath) && Date.now() < deadline) { /* spin to the barrier */ }
         process.stdout.write(ensureOAuthStateKeyFile(keyPath));
        `,
      );

      const child = spawn(TSX, [script, keyPath, goPath], { stdio: ['ignore', 'pipe', 'pipe'] });
      const settled = new Promise<string>((resolve, reject) => {
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('subject timed out before reaching the barrier'));
        }, CHILD_TIMEOUT_MS);
        child.stdout.on('data', (d) => (out += String(d)));
        child.stderr.on('data', (d) => (err += String(d)));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`subject exited ${code}: ${err}`));
          else resolve(out.trim());
        });
      });

      await new Promise((r) => setTimeout(r, 4_000)); // let tsx boot and reach the spin
      writeFileSync(goPath, 'go');

      // Land the sibling's key well inside the 50ms grace. A busy-wait rather
      // than setTimeout on purpose: a timer can slip past 50ms under fleet load,
      // which would red this test against CORRECT code.
      const until = Date.now() + 10;
      while (Date.now() < until) {
        /* precise short wait */
      }
      writeFileSync(keyPath, `${siblingKey}\n`, { mode: 0o600 });

      // Adopting is the whole property: one key across the fleet, and it is the
      // one on disk. Returning a self-generated key here IS the reported bug.
      expect(await settled).toBe(siblingKey);
      expect(readFileSync(keyPath, 'utf8').trim()).toBe(siblingKey);
    },
    CHILD_TIMEOUT_MS + 30_000,
  );

  it('leaves no temp files behind after a contended publish', () => {
    const dir = freshDir();
    const path = join(dir, 'oauth-state-key');
    ensureOAuthStateKeyFile(path);

    const strays = execFileSync('ls', ['-A', dir], { encoding: 'utf8' })
      .split('\n')
      .filter((n) => n && n !== 'oauth-state-key');
    expect(strays).toEqual([]);
  });
});
