/**
 * EI-19341315235545734 — CLAUDE.md's run/test section must route AGENTS at the isolated
 * headless verifier, not at the command that opens a window on the owner's live desktop.
 * See `headless-verify-entrypoint.ts` for why prose is the wrong place for this claim to
 * live unpinned.
 *
 * THREE LAYERS, deliberately (the shape the sibling doc-claims guards carry):
 *
 *   1. FIXTURE CONTROLS — the detector must be able to FAIL. Once the live assertion is
 *      green it stops being evidence that the detector works at all. Each control is the
 *      SHIPPED defect or a near-miss of it, not an invented straw doc.
 *   2. THE LIVE CLAIM — judged against all three copies: in-tree `CLAUDE.md`, `AGENTS.md`
 *      (the codex projection of the same rows), and the corpus. They are projections of
 *      `harness_shared.harness_doc_parts`; `scripts/set-doc-part.ts` +
 *      `scripts/project-doc-parts.mjs --write` are the write path that makes a red here
 *      fixable, and hand-editing the generated files is not.
 *   3. AN EXECUTABLE PROBE — the script the doc names is resolved on disk, executed with
 *      `--help` (which boots nothing and exits 0), and every invocation form the doc
 *      prescribes is checked against the script's OWN usage output. Pattern-matching the
 *      doc against itself would pass on a doc that prescribes a retired flag.
 *
 * The probe layer is what makes this a PIN rather than a style assertion: a rename of
 * the script, or a retired `--boot-only`, reds here instead of being discovered by an
 * agent whose verification run dies at a FATAL it has no context for.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeHeadlessVerifyEntrypoint, HEADLESS_SCRIPT } from './headless-verify-entrypoint';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// The subject paths are ENV-OVERRIDABLE on purpose: that is what makes the copy-out
// mutation tier (CLAUDE.md's tier 2) available for this guard, so proving it falsifiable
// never requires mutating the shared tree and racing the git-sync sweep.
const CLAUDE_MD = process.env.PROBE_CLAUDE_MD || join(ROOT, 'CLAUDE.md');
const AGENTS_MD = process.env.PROBE_AGENTS_MD || join(ROOT, 'AGENTS.md');
const CORPUS =
  process.env.PROBE_CORPUS ||
  join(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md');
const SCRIPT = process.env.PROBE_HEADLESS_SCRIPT || join(ROOT, HEADLESS_SCRIPT);

const HEADING = '## ▶ Running / testing this app — it is the **Tauri DESKTOP app**\n';

/** Pad a fixture past the min-length refusal so we test the RULE, not the guard. */
const pad = (body: string): string =>
  `${HEADING}\n${body}\n\n${'filler filler filler\n'.repeat(20)}\n## Next section\n`;

describe('CLAUDE.md headless-verify entrypoint claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('catches the SHIPPED defect: npm run dev as the primary, unmarked command', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(
        pad(
          '**The ONLY supported way to run or test the app:**\n\n' +
            '```bash\ncd papercusp-desktop && npm run dev   # from the repo root\n```\n\n' +
            'Then drive the **Tauri window** it opens.',
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/PRIMARY COMMAND IS NOT THE ISOLATED VERIFIER/);
      expect(verdict.violations.join('\n')).toMatch(/UNMARKED ATTENDED LAUNCH/);
      expect(verdict.violations.join('\n')).toMatch(/NO HEADLESS ENTRYPOINT/);
    });

    it('catches the near-miss: the script is mentioned, but npm run dev is still first', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(
        pad(
          '```bash\ncd papercusp-desktop && npm run dev\n```\n\n' +
            `For an attended-free run see \`${HEADLESS_SCRIPT}\` (human form above).`,
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/PRIMARY COMMAND IS NOT THE ISOLATED VERIFIER/);
      // The script IS named, so that violation must NOT fire — a guard that reds for
      // every reason at once cannot tell an author which thing to fix.
      expect(verdict.violations.join('\n')).not.toMatch(/NO HEADLESS ENTRYPOINT/);
    });

    it('catches an attended launch that lost its attended/human marker in a reflow', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(
        pad(
          `\`\`\`bash\n${HEADLESS_SCRIPT} -- bash -c 'assertions'\n\`\`\`\n\n` +
            'Or just run `cd papercusp-desktop && npm run dev` from the repo root.\n' +
            'It boots embedded PG, the sidecar, migrations, and the webview.',
        ),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/UNMARKED ATTENDED LAUNCH/);
      expect(verdict.attendedLaunchSites).toHaveLength(1);
      expect(verdict.attendedLaunchSites[0]?.markedAttended).toBe(false);
    });

    it('catches a section with prose but no command block at all', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(
        pad(`Verify UI with ${HEADLESS_SCRIPT}, which isolates the display.`),
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/NO COMMAND BLOCK/);
    });

    it('reports a MISSING section as measured-nothing, never as clean', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(
        `## Some other section\n\n${'filler filler filler\n'.repeat(30)}`,
      );
      expect(verdict.ok).toBe(false);
      expect(verdict.sectionFound).toBe(false);
      expect(verdict.violations.join('\n')).toMatch(/SECTION MISSING/);
    });

    it('refuses a body too short to contain the section rather than passing it', () => {
      expect(() => judgeHeadlessVerifyEntrypoint('# tiny')).toThrow(/Refusing to judge/);
      expect(() => judgeHeadlessVerifyEntrypoint('')).toThrow(/Refusing to judge/);
    });

    it('calibration: the corrected shape passes — the controls are not always-true', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(
        pad(
          '**The ONLY supported way for an AGENT to run or test the app:**\n\n' +
            `\`\`\`bash\n${HEADLESS_SCRIPT} -- bash -c 'assertions'\n` +
            `${HEADLESS_SCRIPT} --boot-only\n\`\`\`\n\n` +
            '**The attended/human form is `cd papercusp-desktop && npm run dev`** — it ' +
            "opens a real window on the owner's live desktop.",
        ),
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.prescribedInvocations).toEqual(['--', '--boot-only']);
    });
  });

  describe('the live claim', () => {
    it('positive control: all three doc copies were actually read', () => {
      // Guards against the whole suite passing over an empty/moved file.
      for (const path of [CLAUDE_MD, AGENTS_MD, CORPUS]) {
        expect(existsSync(path), `${path} must exist`).toBe(true);
        const text = readFileSync(path, 'utf8');
        expect(text.length, `${path} must be non-trivial`).toBeGreaterThan(10_000);
        expect(text).toMatch(/Running \/ testing this app/);
      }
    });

    it('CLAUDE.md routes agents at the isolated verifier', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(readFileSync(CLAUDE_MD, 'utf8'));
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.primaryBlock?.namesHeadlessScript).toBe(true);
    });

    it('AGENTS.md carries the same routing (same rows, codex projection)', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(readFileSync(AGENTS_MD, 'utf8'));
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('the projected corpus carries the same routing', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(readFileSync(CORPUS, 'utf8'));
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    });

    it('every attended-launch mention in the section is marked attended/human', () => {
      const verdict = judgeHeadlessVerifyEntrypoint(readFileSync(CLAUDE_MD, 'utf8'));
      // Non-vacuity: the doc must still NAME the attended form, or "all sites are
      // marked" is trivially true of a doc that dropped it.
      expect(verdict.attendedLaunchSites.length).toBeGreaterThan(0);
      expect(verdict.attendedLaunchSites.every((s) => s.markedAttended)).toBe(true);
    });
  });

  describe('executable probe: the script the doc names really accepts those forms', () => {
    it('the prescribed path resolves to an executable file', () => {
      expect(existsSync(SCRIPT), `${SCRIPT} must exist`).toBe(true);
      expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
    });

    it('every invocation form CLAUDE.md prescribes appears in the script\'s own --help', () => {
      const help = execFileSync(SCRIPT, ['--help'], {
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      // Positive control: --help really produced the usage block, so a missing flag
      // below is the doc being wrong rather than the probe reading nothing.
      expect(help).toMatch(/Usage:/);
      expect(help).toMatch(/<assertion-command\.\.\.>/);

      const verdict = judgeHeadlessVerifyEntrypoint(readFileSync(CLAUDE_MD, 'utf8'));
      expect(verdict.prescribedInvocations.length).toBeGreaterThan(0);
      for (const form of verdict.prescribedInvocations) {
        expect(help, `${HEADLESS_SCRIPT} --help must document ${form}`).toContain(form);
      }
    });
  });
});
