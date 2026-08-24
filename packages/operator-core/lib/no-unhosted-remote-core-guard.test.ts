/**
 * no-unhosted-remote-core-guard.test.ts — the falsifiability lock for
 * `scripts/check-no-unhosted-remote-core.mjs` (WI-5371 / WI-5673).
 *
 * The guard runs green on the clean tree, which only proves the
 * no-false-positive direction. The direction that actually matters — a NEW
 * `store.get({ key })` outside the seam FAILS the build — is invisible to a
 * green run by construction: on a clean tree there is, by definition, no new
 * violation to catch. A guard whose gating property is only ever exercised by
 * the violation that has not happened yet is indistinguishable from a guard
 * that does nothing. Same posture as `no-bespoke-state-read-guard.test.ts`.
 *
 * ⚠ THE EXIT STATUS IS TESTED, NOT JUST THE PREDICATE. A guard can detect
 * perfectly and still exit 0 — the prose ports and the exit status doesn't, and
 * nothing fails when it doesn't (EI-20097325488507587). So the second describe
 * block runs the REAL script end-to-end.
 *
 * ⚠ IT NEVER MUTATES THE SHARED TREE. Planting a violation in-place would be
 * committed by the git-sync sweep even if nothing goes wrong and no handler
 * fails — a `trap` cannot fix that race. So the end-to-end case copies the
 * script into a throwaway tree and plants the violation THERE (the guard
 * resolves its own ROOT from `import.meta.url`, which is what makes this work).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';

/** Repo root — vitest's cwd is `packages/operator-core`, which is NOT it. */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const GUARD_REL = 'scripts/check-no-unhosted-remote-core.mjs';

// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { findOpensByKey } from '../../../scripts/check-no-unhosted-remote-core.mjs';

const find = findOpensByKey as (source: string, fileName?: string) => Array<{ line: number }>;

describe('the detector', () => {
  it('FLAGS a direct open-by-key — the shape that mints a second replica', () => {
    expect(find(`const core = store.get({ key: Buffer.from(hex, 'hex') });`)).toHaveLength(1);
  });

  it('flags the shorthand and multi-line forms (an options object is not one line)', () => {
    expect(find(`store.get({ key, valueEncoding: 'json' });`)).toHaveLength(1);
    expect(
      find(`const s = this.store.get({\n  key: Buffer.from(k, 'hex'),\n  valueEncoding: 'json',\n});`),
    ).toHaveLength(1);
  });

  it('does NOT flag an OWN log opened by name — per-harness, so it can never collide', () => {
    expect(find(`const own = store.get({ name: 'peer-log', valueEncoding: 'json' });`)).toEqual([]);
  });

  it('does NOT flag a BLOCK read on an already-open core', () => {
    // The `[^})]*` body stops at `)`, so a later object literal's `key:` cannot
    // be dragged in across the call boundary.
    expect(find(`const v = await core.get(i, { wait: true });\nconst m = map.get({ key: 1 } as any);`))
      .toHaveLength(1); // only the second line, which IS an object-literal `key`
    expect(find(`const v = await core.get(i, { wait: true });`)).toEqual([]);
  });

  it('does NOT flag prose or a commented-out call — the seam file spells it in its own docs', () => {
    expect(find(`// Remote: \`store.get({ key, valueEncoding: 'json' })\`; a remote needs…`)).toEqual([]);
    expect(find(`/*\n * store.get({ key: k });\n */`)).toEqual([]);
  });

  it('PINS THE KNOWN BLIND SPOT so it is a decision, not a surprise', () => {
    // The seam's own getCore() spreads its options, so the detector cannot see
    // it — which is why peer-log.ts needs no allowlist entry. The same escape
    // is available to a copycat. Documented in the guard header; locked here so
    // that if someone ever widens the detector, this test tells them the
    // allowlist must gain the seam in the same commit.
    expect(find(`return store.get({ ...opts, valueEncoding: 'json' });`)).toEqual([]);
    expect(find(`return store.get(opts);`)).toEqual([]);
  });
});

describe('the script (exit status, end to end)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'unhosted-remote-core-guard-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** A throwaway tree the guard can scan without touching the shared checkout. */
  function plant(source: string | null): string {
    const root = mkdtempSync(join(scratch, 'tree-'));
    mkdirSync(join(root, 'scripts'), { recursive: true });
    cpSync(join(REPO_ROOT, GUARD_REL), join(root, GUARD_REL));
    cpSync(join(REPO_ROOT, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
    // `strip-comments-and-strings.mjs` imports `typescript`; ESM ignores
    // NODE_PATH, so give the throwaway tree a node_modules to walk up into.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'packages/probe/lib'), { recursive: true });
    if (source !== null) writeFileSync(join(root, 'packages/probe/lib/replicate.ts'), source);
    return root;
  }

  function run(root: string): { status: number; output: string } {
    try {
      const output = execFileSync(process.execPath, [join(root, GUARD_REL)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      return { status: 0, output };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('EXITS 1 and names the file when a remote core is opened outside the seam', () => {
    const root = plant(
      `import type Corestore from 'corestore';\n` +
        `export async function attach(store: Corestore, hex: string) {\n` +
        `  const core = store.get({ key: Buffer.from(hex, 'hex'), valueEncoding: 'json' });\n` +
        `  await core.ready();\n` +
        `  return core;\n` +
        `}\n`,
    );
    const { status, output } = run(root);
    expect(status).toBe(1);
    expect(output).toContain('packages/probe/lib/replicate.ts');
    expect(output).toContain('openRemoteLog');
  });

  it('exits 0 on the same tree with the violation removed', () => {
    const { status } = run(plant(null));
    expect(status).toBe(0);
  });

  it('exits 0 for an OWN-log open — the guard must not fire on the safe shape', () => {
    const root = plant(
      `import type Corestore from 'corestore';\n` +
        `export function own(store: Corestore) {\n` +
        `  return store.get({ name: 'own-log', valueEncoding: 'json' });\n` +
        `}\n`,
    );
    expect(run(root).status).toBe(0);
  });

  it('does not fire on a TEST file — a hermetic two-machine sim legitimately mints two replicas', () => {
    const root = plant(null);
    writeFileSync(
      join(root, 'packages/probe/lib/two-machines.test.ts'),
      `it('models two machines', () => { storeB.get({ key: Buffer.from(hex, 'hex') }); });\n`,
    );
    expect(run(root).status).toBe(0);
  });
});

/**
 * THE RATCHET'S ACTUAL OBLIGATION — this file is named as the
 * `hostSuiteRatchet` for `lint:no-unhosted-remote-core` in
 * REPO_WIDE_INVARIANT_GUARDS, which is what lets affected-tests SKIP the guard's
 * own narrow task whenever operator-core's full suite runs (affected-tests.mjs
 * line ~1282). Every path this guard's `appliesTo` matches lives in
 * operator-core, so in practice that skip fires essentially always.
 *
 * The cases above exec the real script but only against SYNTHETIC trees — they
 * prove the detector works and prove nothing about THIS repo. Without the case
 * below, the ratchet claim would be false in exactly the way the registry's own
 * comment warns about: the guard would be "enforced" by a suite that never
 * looks at the tree it is supposed to be guarding.
 */
describe('the ratchet (the real tree, which is what the registry skip is trading against)', () => {
  it('runs the guard against THIS repo and finds no unhosted remote-core opens', () => {
    const res = (() => {
      try {
        return {
          status: 0,
          output: execFileSync(process.execPath, [join(REPO_ROOT, GUARD_REL)], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 60_000,
            killSignal: 'SIGKILL',
          }),
        };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    })();
    expect(res.output).not.toContain('REASON REQUIRED');
    expect(res.status).toBe(0);
  }, 60_000);
});
