/**
 * agent-env-contract-tracked-entries.test.ts — WI-7006 recurrence guard.
 *
 * `AGENT-ENV.md` is a COMMITTED artifact that CI re-derives and compares
 * (`npx tsx scripts/gen-agent-env.ts --check`). So every fact in it must be
 * reproducible from the repository ALONE. It was not: the generator listed
 * workspace roots with a bare `readdirSync`, which also returns directories that
 * exist only in one working tree.
 *
 * What that cost. `packages/locks/` was a fossil of a package that had moved to
 * `libs/papercusp/packages/locks`, left behind holding nothing but a two-month-old
 * empty vitest cache. No package.json, no tracked file, not in `.gitmodules`, and
 * invisible to `git status` because its only content was ignored. It got baked into
 * the committed doc as an 11th `packages/` entry. Every clean CI checkout counted
 * 10, regenerated a different doc, and failed `--check` — at step 6 of ~65, whose
 * ~55 successors had no `if: always()`, so GitHub SKIPPED the entire affected-test
 * suite and every gating lint. Zero green CI runs in 100. It reproduced on no
 * developer machine, because the fossil only existed on the machine that had
 * generated the doc.
 *
 * WHY THIS TEST ASSERTS THE ARTIFACT AND NOT THE GENERATOR'S SOURCE SHAPE: a
 * source-shape assertion ("does it call git?") locks in today's implementation and
 * still passes the moment someone reintroduces the same class through a different
 * call. The invariant that actually matters is a property of the OUTPUT — every
 * directory the contract names must be one the repository really contains — and it
 * holds however the generator is written. It also fails on ANY dev box rather than
 * only in CI, which is the whole point: the original bug was undetectable exactly
 * where people were looking at it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOC = join(REPO_ROOT, 'AGENT-ENV.md');

/** Parse the `<details><summary><code>ROOT/</code> — N entries</summary>` blocks. */
function listedEntries(md: string): Array<{ root: string; declaredCount: number; entries: string[] }> {
  const out: Array<{ root: string; declaredCount: number; entries: string[] }> = [];
  const re =
    /<details><summary><code>([^/]+)\/<\/code> — (\d+) entries<\/summary>\s*\n\s*\n```\n([^`]*)\n```/g;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    out.push({
      root: m[1]!,
      declaredCount: Number(m[2]),
      entries: m[3]!.trim().split(/\s+/).filter(Boolean),
    });
  }
  return out;
}

/** Directory names git actually has under `root/` — tracked trees AND submodule gitlinks. */
function gitEntriesUnder(root: string): Set<string> {
  const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', `${root}/`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => p.slice(root.length + 1))
      .filter((n) => n && !n.includes('/')),
  );
}

describe('AGENT-ENV.md is reproducible from the repository alone (WI-7006)', () => {
  const md = readFileSync(DOC, 'utf8');
  const blocks = listedEntries(md);

  it('parses at least one workspace-root listing out of the doc', () => {
    // Guards the guard: if the doc's shape changes and the regex silently matches
    // nothing, every assertion below would vacuously pass.
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('names no directory that git does not have — a fossil cannot enter the contract', () => {
    const offenders: string[] = [];
    for (const { root, entries } of blocks) {
      const tracked = gitEntriesUnder(root);
      for (const e of entries) if (!tracked.has(e)) offenders.push(`${root}/${e}`);
    }
    expect(
      offenders,
      `AGENT-ENV.md lists ${offenders.join(', ')}, which git does not have under that root.\n` +
        'That is a working-tree-only directory (a build fossil or an empty leftover) baked into a\n' +
        'committed artifact: CI regenerates the doc on a clean clone, gets a different answer, and\n' +
        'fails `gen-agent-env --check` — which skips the whole downstream gate. Delete the stray\n' +
        'directory and re-run `npx tsx scripts/gen-agent-env.ts`; do NOT commit it into the doc.',
    ).toEqual([]);
  });

  it('omits no directory git DOES have — the contract must not under-report either', () => {
    const missing: string[] = [];
    for (const { root, entries } of blocks) {
      const listed = new Set(entries);
      for (const e of gitEntriesUnder(root)) if (!listed.has(e)) missing.push(`${root}/${e}`);
    }
    expect(
      missing,
      `AGENT-ENV.md omits ${missing.join(', ')}. Re-run \`npx tsx scripts/gen-agent-env.ts\`.`,
    ).toEqual([]);
  });

  it('declares a count matching the entries it actually lists', () => {
    for (const { root, declaredCount, entries } of blocks) {
      expect(entries.length, `AGENT-ENV.md says ${root}/ has ${declaredCount} entries`).toBe(
        declaredCount,
      );
    }
  });
});
