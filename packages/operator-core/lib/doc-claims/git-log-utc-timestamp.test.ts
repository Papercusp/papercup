/**
 * EI-20687080717457981 — CLAUDE.md's "which commit carries your change" command must
 * print UTC. See `git-log-utc-timestamp.ts` for the measurement that motivates it.
 *
 * THREE LAYERS, deliberately:
 *
 *   1. FIXTURE CONTROLS — the detector must be able to FAIL. Once the live assertion is
 *      green it stops being evidence that the detector works at all (the reason the
 *      sibling doc-claims guards carry the same section).
 *   2. THE LIVE CLAIM — judged against BOTH copies: in-tree `CLAUDE.md` and the
 *      projected corpus. They are projections of `harness_shared.harness_doc_parts`;
 *      `scripts/set-doc-part.ts` is the write path that makes a red here fixable.
 *   3. AN EXECUTABLE PROBE — the documented command is EXTRACTED from the doc and RUN
 *      against a synthetic repo whose only commit is authored at +09:00. Pattern-
 *      matching the flags would pass on a command that does not actually work; this
 *      layer fails if the prescription stops producing +00:00 for ANY reason.
 *
 * The +09:00 fixture is load-bearing. Every commit in this repo carries -04:00 (the
 * box's own offset), so a probe against real history cannot tell "renders UTC" from
 * "renders the commit's offset, which happens to look local" — the two hypotheses are
 * only separable on a foreign-offset commit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeGitLogUtcClaim, extractGitLogCommands } from './git-log-utc-timestamp';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// The subject paths are ENV-OVERRIDABLE on purpose: that is what makes the copy-out
// mutation tier (CLAUDE.md's tier 2) available for this guard, so proving it falsifiable
// never requires mutating the shared tree and racing the git-sync sweep.
const CLAUDE_MD = process.env.PROBE_CLAUDE_MD || join(ROOT, 'CLAUDE.md');
const CORPUS =
  process.env.PROBE_CORPUS ||
  join(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md');

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string => `${body}\n${'filler filler filler\n'.repeat(20)}`;

describe('CLAUDE.md git-log UTC timestamp claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the inert `TZ=UTC` + `%cI` form — the shipped defect', () => {
      const verdict = judgeGitLogUtcClaim(
        pad("Which commit carries your change → `TZ=UTC git log -1 --format='%cI %H %s' -- <path>`."),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.inertTzSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/INERT/);
    });

    it('catches the inert form for `%cd` with a non-local --date', () => {
      const verdict = judgeGitLogUtcClaim(
        pad("run `TZ=UTC git log -1 --date=iso-strict --format='%cd %H' -- <path>`"),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.inertTzSites).toHaveLength(1);
    });

    it("catches the false 'machine's local timezone' explanation", () => {
      const verdict = judgeGitLogUtcClaim(
        pad(
          "`TZ=UTC git log -1 --date=iso-strict-local --format='%cd %H' -- <p>` — but git renders " +
            "`%ad`/`%cd` in the machine's local timezone (`-0400` here).",
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.machineLocalClaimSites).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/COMMIT's own recorded offset/);
    });

    it('catches the prescription disappearing entirely (false-absence shape)', () => {
      const verdict = judgeGitLogUtcClaim(pad('nothing about git here at all'));
      expect(verdict.ok).toBe(false);
      expect(verdict.commandSites).toHaveLength(0);
      expect(verdict.violations.join('\n')).toMatch(/false-absence/);
    });

    it('PASSES the corrected form', () => {
      const verdict = judgeGitLogUtcClaim(
        pad("`TZ=UTC git log -1 --date=iso-strict-local --format='%cd %H %s' -- <path>`"),
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.commandSites).toHaveLength(1);
    });

    it('REFUSES a short/empty read instead of reporting it clean', () => {
      expect(() => judgeGitLogUtcClaim('')).toThrow(/Refusing to judge/);
      expect(() => judgeGitLogUtcClaim('TZ=UTC git log')).toThrow(/Refusing to judge/);
    });

    it('extractGitLogCommands pulls the runnable invocation out of markdown', () => {
      const cmds = extractGitLogCommands(
        pad("> **Which commit → `TZ=UTC git log -1 --date=iso-strict-local --format='%cd %H' -- <path>`.**"),
      );
      expect(cmds).toHaveLength(1);
      expect(cmds[0]).toMatch(/^TZ=UTC git log/);
      expect(cmds[0]).not.toMatch(/`/);
    });
  });

  describe('the live claim', () => {
    it('positive control: both doc copies were actually read', () => {
      // Guards against the whole suite passing over an empty/moved file.
      const claude = readFileSync(CLAUDE_MD, 'utf8');
      expect(claude.length).toBeGreaterThan(10_000);
      expect(claude).toMatch(/git blame/);

      expect(existsSync(CORPUS)).toBe(true);
      const corpus = readFileSync(CORPUS, 'utf8');
      expect(corpus.length).toBeGreaterThan(10_000);
    });

    it('CLAUDE.md prescribes a command that actually renders UTC', () => {
      const verdict = judgeGitLogUtcClaim(readFileSync(CLAUDE_MD, 'utf8'));
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('the projected corpus carries the same corrected claim', () => {
      const verdict = judgeGitLogUtcClaim(readFileSync(CORPUS, 'utf8'));
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  });

  describe('executable probe: the documented command really prints UTC', () => {
    let repo: string;

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'git-log-utc-probe-'));
      const run = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      run('config', 'user.email', 'probe@example.invalid');
      run('config', 'user.name', 'probe');
      writeFileSync(join(repo, 'subject.txt'), 'content\n');
      run('add', 'subject.txt');
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'authored at +0900'], {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-08-16T12:00:00+09:00',
          GIT_COMMITTER_DATE: '2026-08-16T12:00:00+09:00',
        },
      });
    });

    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    it('positive control: the fixture commit really carries a +09:00 offset', () => {
      // Without this, a probe asserting "+00:00" would also pass on a box whose local
      // zone is UTC — i.e. it would prove nothing about TZ handling at all.
      const raw = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cI'], {
        encoding: 'utf8',
      }).trim();
      expect(raw).toMatch(/\+09:00$/);
    });

    it('NEGATIVE control: the OLD documented form does NOT print UTC', () => {
      // This is the defect, executed. If this ever starts printing +00:00, the premise
      // of this whole guard has changed and the doc advice should be revisited.
      const out = execFileSync(
        'bash',
        ['-c', "TZ=UTC git log -1 --format='%cI' -- subject.txt"],
        { cwd: repo, encoding: 'utf8' },
      ).trim();
      expect(out).toMatch(/\+09:00$/);
      expect(out).not.toMatch(/\+00:00/);
    });

    it('every git-log command CLAUDE.md prescribes prints a +00:00 timestamp', () => {
      const commands = extractGitLogCommands(readFileSync(CLAUDE_MD, 'utf8'));
      // Positive control: the extraction found something to run.
      expect(commands.length).toBeGreaterThan(0);

      for (const cmd of commands) {
        const runnable = cmd.replace(/<path>/g, 'subject.txt');
        const out = execFileSync('bash', ['-c', runnable], {
          cwd: repo,
          encoding: 'utf8',
        }).trim();
        expect(out, `command did not render UTC: ${cmd} -> ${out}`).toMatch(/\+00:00/);
      }
    });
  });
});
