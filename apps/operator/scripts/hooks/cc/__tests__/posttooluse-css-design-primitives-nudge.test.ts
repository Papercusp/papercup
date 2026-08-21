/**
 * posttooluse-css-design-primitives-nudge — the author-time half of the
 * `lint:design-primitives` letter-spacing rule (EI-20023819609804890).
 *
 * Sibling of __tests__/posttooluse-mock-cast-escape-nudge.test.ts, same family and same
 * reason to exist: the hook's value is entirely in WHEN it fires, so the cases that matter
 * are the ones where it must stay SILENT. A nudge that fires on a compliant declaration —
 * or on a pre-existing offender the author did not introduce — trains people to ignore it,
 * which is strictly worse than not having it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../posttooluse-css-design-primitives-nudge.mjs');
// __tests__ → cc → hooks → scripts → operator → apps → <repo root>: SIX levels.
// Getting this wrong is silent in the dangerous direction — the hook FAILS OPEN, so every
// "stays SILENT" case below still passes while proving nothing. The NUDGES case is the
// control that catches it (it did, on the first run of this suite).
const REPO = resolve(HERE, '../../../../../..');

/** Drive the hook exactly as Claude Code does: one JSON object on stdin. */
function runHook(filePath: string): string {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    encoding: 'utf8',
  });
}

describe('posttooluse-css-design-primitives-nudge', () => {
  it('passes its own embedded self-test', () => {
    // Exercises the scoping + multiset-diff + message cases without touching the fs.
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('self-test OK');
  });

  it('resolves the lint\'s real matcher from the repo — not a forked copy', async () => {
    // If this import ever breaks, the hook silently stops nudging (it fails open), so the
    // wiring is asserted explicitly rather than inferred from a passing no-op.
    const mod = await import(
      join(REPO, 'apps/operator/app/_lints/letter-spacing-pattern.mjs')
    );
    expect(mod.findNonzeroLetterSpacing('.x { letter-spacing: 0.04em; }')).toHaveLength(1);
    const titleMod = await import(
      join(REPO, 'apps/operator/app/_lints/title-only-tooltip-pattern.mjs')
    );
    expect(titleMod.findButtonTitleTooltips('<button title="help">x</button>')).toHaveLength(1);
  });

  describe('against real files', () => {
    /** A throwaway tree that LOOKS like the scanned population but has no git HEAD. */
    function scratchCss(contents: string): { dir: string; file: string } {
      const dir = mkdtempSync(join(tmpdir(), 'pc-css-nudge-'));
      const scanned = join(dir, 'apps/operator/app/adv/hud');
      mkdirSync(scanned, { recursive: true });
      // The hook finds the repo root by walking up to the shared matcher module.
      mkdirSync(join(dir, 'apps/operator/app/_lints'), { recursive: true });
      writeFileSync(
        join(dir, 'apps/operator/app/_lints/letter-spacing-pattern.mjs'),
        `export * from ${JSON.stringify(join(REPO, 'apps/operator/app/_lints/letter-spacing-pattern.mjs'))};`,
      );
      writeFileSync(
        join(dir, 'apps/operator/app/_lints/title-only-tooltip-pattern.mjs'),
        `export * from ${JSON.stringify(join(REPO, 'apps/operator/app/_lints/title-only-tooltip-pattern.mjs'))};`,
      );
      const file = join(scanned, 'scratch.css');
      writeFileSync(file, contents);
      return { dir, file };
    }

    it('NUDGES on a newly added banned declaration', () => {
      const { dir, file } = scratchCss('.a { letter-spacing: 0.04em; }\n');
      try {
        const out = runHook(file);
        expect(out).toContain('BANNED letter-spacing ADDED');
        expect(out).toContain('GREEN-CHECKPOINT LEG');
        expect(out).toContain('scratch.css');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('NUDGES on a newly added title-only button tooltip', () => {
      const { dir, file } = scratchCss('<button title="help">x</button>\n');
      try {
        const out = runHook(file);
        expect(out).toContain('TITLE-ONLY BUTTON TOOLTIP ADDED');
        expect(out).toContain('GREEN-CHECKPOINT LEG');
        expect(out).toContain('aria-label');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays SILENT on a compliant file', () => {
      const { dir, file } = scratchCss('.a { letter-spacing: 0; }\n');
      try {
        expect(runHook(file).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays SILENT when the banned value appears only inside a comment', () => {
      // The regression that would make it fire hardest on the best-documented file:
      // hud.css:564 quotes `letter-spacing:0.09em` while explaining its removal.
      const { dir, file } = scratchCss(
        '/* was letter-spacing:0.09em, removed — reds the lint */\n.a { letter-spacing: 0; }\n',
      );
      try {
        expect(runHook(file).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays SILENT when a button title appears only inside a comment', () => {
      const { dir, file } = scratchCss(
        '/* <button title="documented example"> */\nconst ok = true;\n',
      );
      try {
        expect(runHook(file).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('stays SILENT for a file outside the scanned population', () => {
      const dir = mkdtempSync(join(tmpdir(), 'pc-css-nudge-out-'));
      try {
        mkdirSync(join(dir, 'apps/operator/app/_lints'), { recursive: true });
        writeFileSync(
          join(dir, 'apps/operator/app/_lints/letter-spacing-pattern.mjs'),
          `export * from ${JSON.stringify(join(REPO, 'apps/operator/app/_lints/letter-spacing-pattern.mjs'))};`,
        );
        mkdirSync(join(dir, 'packages/operator-core'), { recursive: true });
        const outside = join(dir, 'packages/operator-core/thing.ts');
        writeFileSync(outside, 'const s = { letterSpacing: "0.04em" };\n');
        expect(runHook(outside).trim()).toBe('');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails OPEN (silent, exit 0) on a path that does not exist', () => {
      expect(runHook('/definitely/not/a/real/path.css').trim()).toBe('');
    });
  });
});
