/**
 * harness-test-gate-provenance.test.ts — RETIREMENT GUARD.
 *
 * This file used to pin `itemTestGate`, the legacy VAL test-completion gate: that it
 * resolved stamp-only plan-item provenance (EI-19435123521651527) and that it skipped
 * VALs governed by an enforceable spec clause (WI-10004463).
 * verification-system-improvements-2026-10-10 P-003 (SPEC-P-003-VAL-READERS) retires
 * inline VAL-* assertions, so the gate and its read of the assertion store are gone.
 * Provenance resolution stays covered by `plan-item-provenance.test.ts`; spec-era
 * completion is judged by `specTestAdequacyCompletionGate` and covered by
 * `agent-tools/work_items/spec-test-adequacy-gate.test.ts`.
 *
 * These cases fail if the legacy gate comes back. The file is pending owner deletion
 * with the rest of the VAL-* residue.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

/** The gate's export name and its module specifier. */
const GATE_TOKEN_SRC = '\\bitemTestGate\\b|harness-test-gate';
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'];
const TEST_PATH_RE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)|(\/__fixtures__\/)/;

describe('legacy VAL test-completion gate stays retired (P-003)', () => {
  it('harness-test-gate no longer exports itemTestGate', async () => {
    const mod: Record<string, unknown> = await import('./harness-test-gate');
    expect(Object.keys(mod)).not.toContain('itemTestGate');
  });

  it('work_items:complete no longer calls the legacy gate', () => {
    const file = resolve(HERE, 'agent-tools/work_items/complete.ts');
    const live = stripCommentsOnly(readFileSync(file, 'utf8'), file);
    // Control: the successor gate is still wired, so an empty read cannot pass vacuously.
    expect(live).toContain('specTestAdequacyCompletionGate');
    expect(live).not.toContain('itemTestGate');
    expect(live).not.toContain('harness-test-gate');
  });

  it('no non-test tracked source imports the gate or names itemTestGate in live code', () => {
    // SPEC-P-003-VAL-RETIRED: the bar is the whole tree, not just work_items:complete.
    // `git grep` enumerates TRACKED files (untracked dist bundles are not source); each
    // candidate is re-judged with comments stripped and string literals KEPT, so a live
    // `import … from './harness-test-gate'` still counts.
    const out = execFileSync(
      'git',
      ['grep', '-l', '-I', '-E', GATE_TOKEN_SRC, '--', ...SOURCE_GLOBS],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    const candidates = out.split('\n').filter(Boolean).filter((p) => !TEST_PATH_RE.test(p));
    // Enumeration control: these files mention the gate only in comments, so an empty
    // candidate list would mean the instrument never reached the tree.
    expect(candidates).toContain('packages/operator-core/lib/plan-item-provenance.ts');
    expect(candidates).toContain('packages/operator-core/lib/agent-tools/work_items/complete.ts');
    const gateRe = new RegExp(GATE_TOKEN_SRC);
    const live = candidates.filter((p) =>
      gateRe.test(stripCommentsOnly(readFileSync(resolve(ROOT, p), 'utf8'), p)),
    );
    expect(live).toEqual([]);
  });

  it('detector control: a live import is caught, a comment mention is not', () => {
    const gateRe = new RegExp(GATE_TOKEN_SRC);
    const liveImport = "import { itemTestGate } from './harness-test-gate';\n";
    const commentOnly = '// the retired harness-test-gate used itemTestGate\nexport {};\n';
    expect(gateRe.test(stripCommentsOnly(liveImport, 'x.ts'))).toBe(true);
    expect(gateRe.test(stripCommentsOnly(commentOnly, 'x.ts'))).toBe(false);
  });
});
