/**
 * objective-title-parity.test.ts — WI-1963 title parity (owner ask 2026-07-03, request #3).
 *
 * Codex and OMP have no bottom status pane (that's a Claude-Code-only TUI feature), but they
 * own their title bar. `posttooluse-objective-title.sh` now renders the SAME `term_title` the
 * Claude statusline (`statusline-fleet.sh`) writes: fleets (👑/👤 + colour squares), loop chip,
 * model·effort, id, objective. The two scripts each embed their own copy of that assembly (the
 * hooks are self-contained — installed by individual `cp`, no shared module), so THIS suite is
 * the drift guard: for the same glance + SID + equivalent model, the two titles must be equal.
 * A change to one term_title that isn't mirrored in the other fails CI here.
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

/** The title the CODEX/OMP hook writes (as an OSC-0 escape to its tty; we point that at a temp
 *  file and strip the ESC]0;…BEL wrapper), given a glance fixture + a launch model spec env. */
function codexTitle(glance: unknown, modelSpec: string): string {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.cx.json`);
  const ttyFile = join(dir, `${Math.random().toString(36).slice(2)}.cx.tty`);
  writeFileSync(fixture, JSON.stringify(glance));
  execFileSync('bash', [OBJ_TITLE], {
    encoding: 'utf8',
    input: '{}',
    env: {
      ...process.env,
      PAPERCUSP_OBJECTIVE_FIXTURE: fixture,
      PAPERCUSP_OBJECTIVE_TTY: ttyFile,
      PAPERCUSP_OBJECTIVE_SYNC: '1',
      PAPERCUSP_SID: SID,
      ...(modelSpec ? { PAPERCUSP_MODEL: modelSpec } : {}),
    },
  });
  let raw = '';
  try {
    raw = readFileSync(ttyFile, 'utf8');
  } catch {
    return '';
  }
  // Strip the OSC-0 wrapper: ESC ] 0 ; <title> BEL.
  const m = raw.match(/\x1b\]0;([\s\S]*?)\x07/);
  return m ? m[1] : '';
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
