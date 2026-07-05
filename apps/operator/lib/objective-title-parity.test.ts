/**
 * objective-title-parity.test.ts — WI-1963 title parity (owner ask 2026-07-03, request #3),
 * extended for the SINGLE-SOURCE display pipe (tui-status-parity-single-source-2026-07-05).
 *
 * Codex and OMP have no bottom status pane (that's a Claude-Code-only TUI feature), but they
 * own their title bar. Since 2026-07-05 the title is rendered ONCE server-side
 * (status-display.ts → coord:glance `display.title`) and every hook pipes it VERBATIM —
 * parity by construction; the first describe below proves the pipe. The embedded `term_title`
 * copies in the two scripts survive ONLY as the fallback for a pre-display operator, and the
 * legacy describes remain the drift guard for that fallback: for the same display-less glance
 * + SID + equivalent model, the two titles must be equal.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const STATUSLINE = resolve(__dirname, '../scripts/hooks/cc/statusline-fleet.sh');
const OBJ_TITLE = resolve(__dirname, '../scripts/hooks/cc/posttooluse-objective-title.sh');
const dir = mkdtempSync(join(tmpdir(), 'title-parity-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SID = 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353';

/** The title the CLAUDE statusline writes (raw, via its TITLE_OUT test seam), given a glance
 *  fixture + a piped live-model stdin JSON. */
function claudeTitle(glance: unknown, stdin: string): string {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.cc.json`);
  const titleFile = join(dir, `${Math.random().toString(36).slice(2)}.cc.title`);
  writeFileSync(fixture, JSON.stringify(glance));
  execFileSync('bash', [STATUSLINE], {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
      PAPERCUSP_STATUSLINE_TITLE_OUT: titleFile,
      PAPERCUSP_SID: SID,
      COLUMNS: '200',
    },
  });
  try {
    return readFileSync(titleFile, 'utf8');
  } catch {
    return '';
  }
}

/** Run the CODEX hook against a glance fixture: returns the TITLE it wrote (OSC-0 escape to its
 *  tty, unwrapped) AND its stdout (the tip-notice additionalContext JSON channel). The notice
 *  cursor is pointed at a per-call temp cache dir unless the caller pins one (dedup tests). */
function codexRun(
  glance: unknown,
  modelSpec: string,
  extraEnv: Record<string, string> = {},
): { title: string; stdout: string } {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.cx.json`);
  const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.cx.tty`);
  writeFileSync(fixture, JSON.stringify(glance));
  const stdout = execFileSync('bash', [OBJ_TITLE], {
    encoding: 'utf8',
    input: '{}',
    env: {
      ...process.env,
      PAPERCUSP_OBJECTIVE_FIXTURE: fixture,
      PAPERCUSP_OBJECTIVE_TTY: ttyFile,
      PAPERCUSP_OBJECTIVE_SYNC: '1',
      PAPERCUSP_SID: SID,
      // Keep test cursor writes OUT of the real ~/.papercusp/locks-cache.
      PAPERCUSP_LOCKS_CACHE_DIR: join(dir, `cache-${Math.random().toString(36).slice(2)}`),
      ...(modelSpec ? { PAPERCUSP_MODEL: modelSpec } : {}),
      ...extraEnv,
    },
  });
  let raw = '';
  try {
    raw = readFileSync(ttyFile, 'utf8');
  } catch {
    return { title: '', stdout };
  }
  // Strip the OSC-0 wrapper: ESC ] 0 ; <title> BEL.
  const m = raw.match(/\x1b\]0;([\s\S]*?)\x07/);
  return { title: m ? m[1] : '', stdout };
}

/** The title the CODEX/OMP hook writes, given a glance fixture + a launch model spec env. */
function codexTitle(glance: unknown, modelSpec: string): string {
  return codexRun(glance, modelSpec).title;
}

const base = {
  ok: true,
  wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
  bees: { running: 0 },
  governor: { anyPaused: false, paused: [] },
  activity: [],
  tips: [],
};

// Model display was REMOVED from both titles 2026-07-03 (owner directive, WI-2124). We still feed a
// live-model stdin (Claude) and a launch model spec (codex/omp) that USED to render a model tag, to
// prove neither title surfaces the model any more AND that the two stay byte-identical without it.
const CC_STDIN = JSON.stringify({ model: { display_name: 'Opus 4.8 (1M context)' }, effort: 'xhigh' });
const CODEX_SPEC = 'opus[1m]:xhigh';

describe('SINGLE-SOURCE display pipe — title parity BY CONSTRUCTION (tui-status-parity 2026-07-05)', () => {
  const display = {
    title: '👑 windows-parity 🟦 · ⟳1m · ⏸ ✉4 · ☕2 · 2p · su-9859e · 🔭 Resume Linux release readiness',
    statusline: ['🔭 Resume Linux release readiness · ◇ su-9859e'],
    notice: null,
  };

  it('both CLIs print display.title VERBATIM — byte-identical, zero local assembly', () => {
    // A local self.objective that WOULD render differently is present — the display
    // block must win on both sides, proving the pipe (not the fallback) ran.
    const glance = { ...base, display, self: { objective: 'LOCAL objective (must not render)' } };
    const cc = claudeTitle(glance, CC_STDIN);
    const cx = codexTitle(glance, CODEX_SPEC);
    expect(cc).toBe(display.title);
    expect(cx).toBe(display.title);
  });

  it('control chars in display.title are stripped IDENTICALLY on both sides (OSC safety)', () => {
    const glance = { ...base, display: { ...display, title: 'safe\x1b]0;pwn\x07 title' } };
    const cc = claudeTitle(glance, '{}');
    const cx = codexTitle(glance, '');
    expect(cx).toBe(cc);
    expect(cc).toBe('safe]0;pwn title');
  });

  it('a display block WITHOUT a title falls back to the shared legacy render on both sides', () => {
    const glance = { ...base, display: { ...display, title: null }, self: { objective: 'fallback objective' } };
    const cc = claudeTitle(glance, '{}');
    const cx = codexTitle(glance, '');
    expect(cx).toBe(cc);
    expect(cc).toContain('fallback objective');
  });
});

describe('Codex 💡 tip notice — PostToolUse additionalContext injection (P-003 codex leg)', () => {
  const noticeGlance = {
    ...base,
    display: {
      title: 'su-9859e',
      statusline: ['◇ su-9859e'],
      notice: { id: 'wake-mode-manual', text: '💡 Wake mode is manual — back to auto: coord:wake-mode mode=auto' },
    },
  };

  it('a NEW notice emits the PostToolUse additionalContext JSON on stdout', () => {
    const { stdout } = codexRun(noticeGlance, '');
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('papercusp-status-tip');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Wake mode is manual');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('coord:glance for detail');
  });

  it('the SAME notice is deduped by the per-session cursor (second run stays silent)', () => {
    const cache = { PAPERCUSP_LOCKS_CACHE_DIR: join(dir, `cache-dedup-${Math.random().toString(36).slice(2)}`) };
    expect(codexRun(noticeGlance, '', cache).stdout.trim()).not.toBe('');
    expect(codexRun(noticeGlance, '', cache).stdout.trim()).toBe('');
  });

  it('a CHANGED notice re-emits through the same cursor', () => {
    const cache = { PAPERCUSP_LOCKS_CACHE_DIR: join(dir, `cache-chg-${Math.random().toString(36).slice(2)}`) };
    expect(codexRun(noticeGlance, '', cache).stdout.trim()).not.toBe('');
    const changed = {
      ...base,
      display: {
        ...noticeGlance.display,
        notice: { id: 'governor-paused', text: '💡 Rate governor paused — turns queue' },
      },
    };
    const { stdout } = codexRun(changed, '', cache);
    expect(stdout).toContain('Rate governor paused');
  });

  it('PAPERCUSP_TIP_NOTICE=0 disables the channel', () => {
    expect(codexRun(noticeGlance, '', { PAPERCUSP_TIP_NOTICE: '0' }).stdout.trim()).toBe('');
  });

  it('no notice → no stdout (the title leg still runs)', () => {
    const { stdout, title } = codexRun({ ...base, display: { title: 'su-9859e', statusline: [], notice: null } }, '');
    expect(stdout.trim()).toBe('');
    expect(title).toBe('su-9859e');
  });
});

describe('Codex/OMP title ⟷ Claude statusline title PARITY (WI-1963 #3)', () => {
  it('a multi-fleet leader renders an identical title on both CLIs', () => {
    const glance = {
      ...base,
      self: {
        objective: 'wire the cross-CLI title',
        loop: { active: true, intervalSec: 120, parked: false },
        fleets: [
          { slug: 'roman-fleet', label: 'roman', role: 'leader', square: '🟪' },
          { slug: 'greek-fleet', label: 'greek', role: 'leader', square: '🟩' },
        ],
      },
    };
    const cc = claudeTitle(glance, CC_STDIN);
    const cx = codexTitle(glance, CODEX_SPEC);
    expect(cx).toBe(cc);
    // sanity: the shared shape actually rendered (not two empty strings agreeing)
    expect(cc).toContain('👑 roman 🟪');
    expect(cc).not.toContain('opus'); // WI-2124: model no longer in the title (even with a model stdin/spec fed)
    expect(cc).not.toContain('[1m]');
    expect(cc).toContain('⟳2m');
    expect(cc).toContain('su-9859e');
  });

  it('a member fleet + no loop renders identically', () => {
    const glance = {
      ...base,
      self: { objective: null, fleets: [{ slug: 'blue', label: 'blue', role: 'member', square: '🟦' }] },
    };
    expect(codexTitle(glance, CODEX_SPEC)).toBe(claudeTitle(glance, CC_STDIN));
  });

  it('no fleet / no loop / no model → identical (just the id)', () => {
    const glance = { ...base, self: { objective: null } };
    const cc = claudeTitle(glance, '{}');
    const cx = codexTitle(glance, '');
    expect(cx).toBe(cc);
    expect(cc).toBe('su-9859e');
  });

  it('objective-only renders identically (id + objective, no 🔭 in the title)', () => {
    const glance = { ...base, self: { objective: 'ship the fleet UI' } };
    const cc = claudeTitle(glance, '{}');
    const cx = codexTitle(glance, '');
    expect(cx).toBe(cc);
    expect(cc).toContain('ship the fleet UI');
  });
});

describe('Codex/OMP objective-title hook — model REMOVED (WI-2124)', () => {
  it('does NOT render a model tag even when PAPERCUSP_MODEL is set', () => {
    const glance = { ...base, self: { objective: null } };
    const title = codexTitle(glance, 'sonnet:medium');
    expect(title).not.toContain('sonnet');
    expect(title).not.toContain('/medium');
    expect(title).toBe('su-9859e'); // just the id — no model
  });

  it('a bare 1M family spec produces no [1m] marker in the title', () => {
    const glance = { ...base, self: { objective: null } };
    expect(codexTitle(glance, 'opus[1m]')).not.toContain('[1m]');
  });

  it('no model + no glance detail still anchors the title with the id', () => {
    expect(codexTitle({ ...base, self: {} }, '')).toBe('su-9859e');
  });
});
