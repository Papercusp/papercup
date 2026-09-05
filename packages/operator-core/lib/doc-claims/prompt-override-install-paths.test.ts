/**
 * P-002 / D-004(3) / D-018 — the census guard for prompt-override INSTALL paths.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the doc-claims siblings state:
 * once the live assertion goes green it stops being evidence that the detector works at
 * all. Each control below reproduces a shape that MUST be caught — in particular the
 * multi-line INSERT, because a census that silently skips a real install path reads
 * exactly like a census that found nothing wrong.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASSIFIED_INSTALL_SITES,
  findPromptOverrideInstallSites,
  judgeCommitPathGating,
  judgeInstallCensus,
  COMMIT_INSTALL_FN,
} from './prompt-override-install-paths';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TABLE = 'harness_shared.harness_prompt_overrides';

/**
 * Candidate files: every tracked-or-new .ts mentioning the table.
 *
 * `--untracked` is deliberate — the case this guard exists for is an agent ADDING a new
 * install path, and on this tree that file is uncommitted for the first few minutes,
 * which is precisely when the author is running tests. Submodule .ts is out of scope
 * (`--untracked` and `--recurse-submodules` are mutually exclusive); verified 2026-09-05
 * that no submodule .ts writes this table — the only submodule hits are SQL schema.
 */
function candidateFiles(): string[] {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '--untracked', '-l', '-F', TABLE, '--', '*.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch {
    return []; // git grep exits 1 on no matches; the calibration below turns that into a failure.
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    // Test fixtures and this guard's own registry are not runtime install paths.
    .filter((p) => !/\.test\.ts$/.test(p) && !p.includes('/__tests__/') && !p.includes('/lib/doc-claims/'));
}

describe('prompt-override install-path census (P-002 / D-004(3) / D-018)', () => {
  describe('fixture controls — the detector must be able to FAIL', () => {
    it('finds a plain INSERT and attributes it to the enclosing top-level export', () => {
      const sites = findPromptOverrideInstallSites(`
export async function installIt(sql) {
  await sql\`INSERT INTO ${TABLE} (workspace_id) VALUES (1)\`;
}
`);
      expect(sites).toHaveLength(1);
      expect(sites[0].symbol).toBe('installIt');
    });

    it('finds an INSERT split across lines — the false-NEGATIVE direction', () => {
      const sites = findPromptOverrideInstallSites(`
export async function sneaky(sql) {
  await sql\`
    INSERT INTO
      ${TABLE} (workspace_id)
    VALUES (1)\`;
}
`);
      expect(sites).toHaveLength(1);
      expect(sites[0].symbol).toBe('sneaky');
    });

    it('attributes to the enclosing top-level export, not an inner closure', () => {
      const sites = findPromptOverrideInstallSites(`
export async function decideProposal(sql) {
  const run = async (tx) => {
    await tx\`INSERT INTO ${TABLE} (workspace_id) VALUES (1)\`;
  };
  return run(sql);
}
`);
      expect(sites[0].symbol).toBe('decideProposal');
    });

    it('ignores reads and deletes — only an INSERT can make a prompt live', () => {
      const sites = findPromptOverrideInstallSites(`
export async function readIt(sql) {
  await sql\`SELECT prompt_md FROM ${TABLE}\`;
  await sql\`DELETE FROM ${TABLE} WHERE workspace_id = 1\`;
}
`);
      expect(sites).toEqual([]);
    });

    it('ignores a commented-out INSERT', () => {
      const sites = findPromptOverrideInstallSites(`
export async function nope(sql) {
  // await sql\`INSERT INTO ${TABLE} (workspace_id) VALUES (1)\`;
  /* INSERT INTO ${TABLE} */
}
`);
      expect(sites).toEqual([]);
    });

    it('census flags an UNCLASSIFIED install path and says what to do about it', () => {
      const v = judgeInstallCensus(['a.ts::known', 'b.ts::brandNew'], {
        'a.ts::known': { disposition: 'manual-authoring', why: 'fixture' },
      });
      expect(v.ok).toBe(false);
      expect(v.unclassified).toEqual(['b.ts::brandNew']);
      expect(v.violations.join('\n')).toMatch(/realAnchorHeld/);
    });

    it('census flags a STALE registry entry, so the guard cannot become the drift it prevents', () => {
      const v = judgeInstallCensus([], { 'gone.ts::removed': { disposition: 'manual-authoring', why: 'fixture' } });
      expect(v.ok).toBe(false);
      expect(v.stale).toEqual(['gone.ts::removed']);
    });

    it('commit-path guard catches an install with no real-anchor gate in the file', () => {
      const v = judgeCommitPathGating(`
export async function accept(tx, p) {
  return ${COMMIT_INSTALL_FN}(tx, { proposal: p });
}
`);
      expect(v.ok).toBe(false);
      expect(v.callsCommitInstall).toBe(true);
      expect(v.gated).toBe(false);
    });

    it('commit-path guard does not mistake the DECLARATION for a call', () => {
      // Caught by the live assertion below on first run: the installer's own module matched a
      // naive `name(` probe and reported itself as an ungated caller.
      const v = judgeCommitPathGating(`
export async function ${COMMIT_INSTALL_FN}(sql, input) {
  return commitAndReproject(sql, input);
}
`);
      expect(v.callsCommitInstall).toBe(false);
      expect(v.ok).toBe(true);
    });

    it('commit-path guard passes when the gate is present, and is silent on unrelated files', () => {
      const gated = judgeCommitPathGating(`
const hold = realAnchorHeld(p.candidateVersion);
if (!hold.held) return refuse(hold);
return ${COMMIT_INSTALL_FN}(tx, { proposal: p });
`);
      expect(gated.ok).toBe(true);

      const unrelated = judgeCommitPathGating('export const x = 1;');
      expect(unrelated.ok).toBe(true);
      expect(unrelated.callsCommitInstall).toBe(false);
    });
  });

  describe('the live tree', () => {
    const files = candidateFiles();

    it('calibration: the scan actually reaches source (a zero-file scan would pass vacuously)', () => {
      expect(files.length).toBeGreaterThan(0);
      expect(Object.keys(CLASSIFIED_INSTALL_SITES).length).toBeGreaterThan(0);
      // The gated challenger install must be in the registry AND classified as gated —
      // without this, emptying the registry would make the census below trivially green.
      expect(CLASSIFIED_INSTALL_SITES['packages/operator-core/lib/gym/control-plane.ts::decideProposal']).toMatchObject(
        { disposition: 'gated-install' },
      );
    });

    it('every path that can make a prompt live is classified, and every classification is real', () => {
      const found: string[] = [];
      for (const rel of files) {
        for (const site of findPromptOverrideInstallSites(readFileSync(join(ROOT, rel), 'utf8'))) {
          found.push(`${rel}::${site.symbol}`);
        }
      }
      const verdict = judgeInstallCensus(found);
      expect(verdict.violations.join('\n')).toBe('');
      expect(verdict.ok).toBe(true);
    });

    it(`every caller of ${COMMIT_INSTALL_FN} reaches the real-anchor gate`, () => {
      let callers = 0;
      let out = '';
      try {
        out = execFileSync('git', ['grep', '--untracked', '-l', '-F', `${COMMIT_INSTALL_FN}(`, '--', '*.ts'], {
          cwd: ROOT,
          encoding: 'utf8',
        });
      } catch {
        out = '';
      }
      for (const rel of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
        if (/\.test\.ts$/.test(rel) || rel.includes('/__tests__/') || rel.includes('/lib/doc-claims/')) continue;
        const src = readFileSync(join(ROOT, rel), 'utf8');
        const v = judgeCommitPathGating(src);
        if (!v.callsCommitInstall) continue; // the definition site itself
        callers++;
        expect(v.violations.join('\n'), rel).toBe('');
      }
      // Calibration: if this ever drops to zero the assertion above is checking nothing.
      expect(callers).toBeGreaterThan(0);
    });
  });
});
