/**
 * statusline-fleet.test.ts — the fleet statusline's render logic, driven
 * through the script's PAPERCUSP_STATUSLINE_FIXTURE sync mode (no operator, no
 * token). Asserts the glance render (wake glyph / staged ✉ / 🐝 / governor ⏳ /
 * peers / 💡 tip / ⋯ detail-affordance row) and the quiet-state single line.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../scripts/hooks/cc/statusline-fleet.sh');
const dir = mkdtempSync(join(tmpdir(), 'statusline-fixture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(glance: unknown, extraEnv: Record<string, string> = {}, input = '{}'): string {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixture, JSON.stringify(glance));
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
      PAPERCUSP_SID: 'su-me',
      COLUMNS: '200',
      ...extraEnv,
    },
  });
}

/** Render, and return the OSC-0 window TITLE the script computed. The real title
 *  target (/dev/tty) is not captured by execFileSync, so the script honors
 *  PAPERCUSP_STATUSLINE_TITLE_OUT (a test-only seam) and writes the title there. */
function titleOf(glance: unknown, extraEnv: Record<string, string> = {}, input = '{}'): string {
  const titleFile = join(dir, `${Math.random().toString(36).slice(2)}.title`);
  render(glance, { ...extraEnv, PAPERCUSP_STATUSLINE_TITLE_OUT: titleFile }, input);
  try {
    return readFileSync(titleFile, 'utf8');
  } catch {
    return ''; // no title written (nothing meaningful) — treated as empty
  }
}

const activity = [
  { owner_id: 'su-peer-aaaaaa', summary: '✎ catalog.ts', kind: 'tool', created_at: 't' },
  { owner_id: 'su-peer-bbbbbb', summary: '▶ npm test', kind: 'tool', created_at: 't' },
];

describe('statusline-fleet render (fixture mode)', () => {
  it('manual mode with staged wakes → ⏸ ✉ on line 1, 💡 tip with the slash command on line 2', () => {
    const out = render({
      ok: true,
      wake: { default: 'manual', stagedTotal: 2, stagedOwners: 1 },
      bees: { running: 1 },
      governor: { anyPaused: false, paused: [] },
      activity,
      tips: [
        {
          id: 'wake-mode-manual',
          text: 'Wake mode is manual — 2 staged wakes waiting; the queen won\'t self-drive. Back to auto:',
          command: '/mcp__papercusp-su__tool:coord:wake-mode mode=auto',
          invoke: { tool: 'coord:wake-mode', args: { mode: 'auto' } },
        },
      ],
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('◇ su-me');
    expect(lines[0]).toContain('◇ su-me'); // THIS agent's own shorthand id chip
    expect(lines[0]).toContain('⏸ manual ✉2');
    expect(lines[0]).toContain('🐝1');
    expect(lines[0]).toContain('2 peers');
    expect(lines[0]).toContain('◆ aaaaaa ✎ catalog.ts');
    expect(lines[1]).toBe(
      "💡 Wake mode is manual — 2 staged wakes waiting; the queen won't self-drive. Back to auto: /mcp__papercusp-su__tool:coord:wake-mode mode=auto",
    );
    // When a tip row is shown, a final ⋯ row points at the full glance dump.
    expect(lines[2]).toBe('⋯ run /mcp__papercusp-su__tool:coord:glance for detail');
  });

  it('quiet auto fleet → one line, ▶ auto, no tip row', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
    });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('▶ auto');
    expect(out).toContain('solo');
    expect(out).not.toContain('💡');
    expect(out).not.toContain('🐝');
  });

  it('governor pause renders ⏳ with the bucket key', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: {
        anyPaused: true,
        paused: [{ key: 'anthropic:opus', pausedUntil: '2026-06-12T01:00:00Z' }],
      },
      activity,
      tips: [{ id: 'governor-paused', text: 'Rate governor paused (anthropic:opus)', command: null }],
    });
    const lines = out.split('\n');
    expect(lines[0]).toContain('⏳ anthropic:opus');
    expect(lines[1]).toContain('💡 Rate governor paused');
    expect(lines[2]).toBe('⋯ run /mcp__papercusp-su__tool:coord:glance for detail');
  });

  it('rows fit COLUMNS; a pathological tip wraps but is capped at 4 rows', () => {
    const out = render(
      {
        ok: true,
        wake: { default: 'manual', stagedTotal: 9, stagedOwners: 3 },
        bees: { running: 2 },
        governor: { anyPaused: false, paused: [] },
        activity,
        tips: [{ id: 't', text: 'x'.repeat(300), command: null, invoke: null }],
      },
      { COLUMNS: '50' },
    );
    const lines = out.split('\n');
    // Code points, not UTF-16 units — python truncates/wraps per code point,
    // and 💡/🐝 are 2 UTF-16 units each.
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(50);
    expect(lines.length).toBeLessThanOrEqual(6); // fleet row + ≤4 tip rows + ⋯ detail row
  });

  it('a narrow pane wraps the tip across rows — full text AND command survive', () => {
    const text = "Wake mode is manual — 2 staged wakes waiting; the queen won't self-drive. Back to auto:";
    const cmd = '/mcp__papercusp-su__tool:coord:wake-mode mode=auto';
    const out = render(
      {
        ok: true,
        wake: { default: 'manual', stagedTotal: 2, stagedOwners: 1 },
        bees: { running: 0 },
        governor: { anyPaused: false, paused: [] },
        activity: [],
        tips: [{ id: 'wake-mode-manual', text, command: cmd, invoke: null }],
      },
      { COLUMNS: '44' },
    );
    const lines = out.split('\n');
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(44);
    // Re-join the wrapped tip rows: nothing the renderer was given is lost.
    const rejoined = lines.slice(1).map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
    expect(rejoined).toContain('2 staged wakes waiting');
    expect(rejoined.replace(/ /g, '')).toContain(cmd.replace(/ /g, '').slice(0, 40));
  });

  it('activity-shaped fixture (no wake key) exercises the legacy fallback render', () => {
    const out = render({ activity });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('◇ su-me');
    expect(out).not.toContain('papercusp'); // #2: the static label was removed (owner ask)
    expect(out).toContain('2 peers');
    expect(out).not.toContain('💡');
  });

  it("a real uuid-shaped SID renders as the coord ownerLabel short form (◇ su-<first5>)", () => {
    const out = render(
      {
        ok: true,
        wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
        bees: { running: 0 },
        governor: { anyPaused: false, paused: [] },
        activity: [],
        tips: [],
      },
      { PAPERCUSP_SID: 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353' },
    );
    // su-9859e == the ownerLabel form (role prefix + first 5 of the uuid body),
    // NOT the last-6 (a21353) used for the ◆ peer chip.
    expect(out).toContain('◇ su-9859e');
    expect(out).not.toContain('a21353');
  });

  it('self.objective renders as a leading 🔭 segment ahead of the fleet shorthand', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: 'wire objective display' },
    });
    const line1 = out.split('\n')[0];
    // 🔭 leads — ahead of the ◇ id chip.
    expect(line1.startsWith('🔭 wire objective display · ◇ su-me')).toBe(true);
    expect(line1).toContain('◇ su-me');
  });

  it('absent self.objective → no 🔭 segment (line 1 unchanged)', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: null },
    });
    expect(out).not.toContain('🔭');
    expect(out.split('\n')[0].startsWith('◇ su-me')).toBe(true);
  });

  it('a missing self key (older operator) → no 🔭 segment, render fails open', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
    });
    expect(out).not.toContain('🔭');
    expect(out.split('\n')[0].startsWith('◇ su-me')).toBe(true);
  });

  it('a blank-string objective is treated as absent — no empty 🔭 segment', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: '   ' },
    });
    expect(out).not.toContain('🔭');
    expect(out.split('\n')[0].startsWith('◇ su-me')).toBe(true);
  });

  it('a long objective is clipped with an ellipsis so it cannot swallow line 1', () => {
    const long = 'implement the cross-CLI session objective display across every fleet client now';
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: long },
    });
    const line1 = out.split('\n')[0];
    expect(line1.startsWith('🔭 ')).toBe(true);
    expect(line1).toContain('…');
    // The clipped objective segment stays well under the full objective length.
    const objSeg = line1.split(' · ')[0];
    expect([...objSeg].length).toBeLessThanOrEqual(50);
    expect(line1).toContain('◇ su-me');
  });

  it('the 🔭 objective also leads the legacy fallback line when present', () => {
    // Activity-shaped payload (no wake key) but WITH a self.objective → the
    // segment leads the single-line legacy render too.
    const out = render({ activity, self: { objective: 'legacy path objective' } });
    expect(out.split('\n')).toHaveLength(1);
    expect(out.startsWith('🔭 legacy path objective · ◇ su-me')).toBe(true);
    expect(out).toContain('2 peers');
  });

  it('an active+reachable loop renders the ⟳ <interval> loop chip (no unreachable marker)', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: null, loop: { active: true, intervalSec: 120, parked: false, reachable: true } },
    });
    expect(out).toContain('⟳ 2m loop');
    expect(out).not.toContain('unreachable');
  });

  it('WI-655: an active loop with reachable:false renders ⟳ <interval> loop ⚠unreachable', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: null, loop: { active: true, intervalSec: 120, parked: true, reachable: false } },
    });
    expect(out).toContain('⟳ 2m loop ⚠unreachable');
  });

  it('a loop payload WITHOUT the reachable field (older operator) → plain chip, no scary text', () => {
    const out = render({
      ok: true,
      wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
      bees: { running: 0 },
      governor: { anyPaused: false, paused: [] },
      activity: [],
      tips: [],
      self: { objective: null, loop: { active: true, intervalSec: 1800, parked: false } },
    });
    expect(out).toContain('⟳ 30m loop');
    expect(out).not.toContain('unreachable');
  });

  it('garbage fixture prints nothing and exits 0', () => {
    expect(render([1, 2, 3])).toBe('');
  });

  const quietGlance = {
    ok: true,
    wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
    bees: { running: 0 },
    governor: { anyPaused: false, paused: [] },
    activity: [],
    tips: [],
    self: { objective: null },
  };

  it('renders the 🧠 <model>·<effort> chip from the piped session JSON (model.display_name + effort)', () => {
    const out = render(quietGlance, {}, JSON.stringify({
      model: { display_name: 'Opus 4.8 (1M context)', id: 'claude-opus-4-8' },
      effort: 'xhigh',
    }));
    // family + the [1m] 1M-context marker + the reasoning-effort setting — the model+settings the human asked to see.
    expect(out).toContain('🧠 opus[1m]·xhigh');
  });

  it('compacts a non-1M model with no [1m] marker (sonnet·medium)', () => {
    const out = render(quietGlance, {}, JSON.stringify({
      model: { display_name: 'Sonnet 4.5', id: 'claude-sonnet-4-5' },
      effort: 'medium',
    }));
    expect(out).toContain('🧠 sonnet·medium');
    expect(out).not.toContain('[1m]');
  });

  it('model present but effort absent → chip shows the model alone (no trailing separator)', () => {
    const out = render(quietGlance, {}, JSON.stringify({ model: { display_name: 'Opus 4.8 (1M context)' } }));
    expect(out).toContain('🧠 opus[1m]');
    expect(out).not.toContain('opus[1m]·');
  });

  it('no session-JSON model (fixture/no-stdin shape) → no 🧠 chip, render unchanged', () => {
    // No settings-fixture env here, so settings stay empty (a dev's ~/.claude/settings.json is
    // read ONLY in a real, non-fixture session) — nothing to derive a label from.
    expect(render(quietGlance)).not.toContain('🧠');
  });

  // ── #1 model accuracy: the LIVE model is authoritative; the stale launch spec must not leak ──
  it('#1: a stale launch settings.model does NOT contaminate the LIVE model (opus→sonnet drops [1m])', () => {
    // The reported bug: after /model-switching to a non-1M sonnet, the persisted launch spec
    // (opus[1m]:xhigh) still marked the live model [1m] and could override its family.
    const out = render(
      quietGlance,
      { PAPERCUSP_STATUSLINE_SETTINGS_FIXTURE: JSON.stringify({ model: 'opus[1m]:xhigh', effortLevel: 'high' }) },
      JSON.stringify({ model: { display_name: 'Sonnet 4.5', id: 'claude-sonnet-4-5' } }),
    );
    expect(out).toContain('🧠 sonnet·high'); // live sonnet wins; effort still from settings
    expect(out).not.toContain('opus');
    expect(out).not.toContain('[1m]');
  });

  it('#1: settings.model [1m] REINFORCES the live model ONLY when the family matches', () => {
    const out = render(
      quietGlance,
      { PAPERCUSP_STATUSLINE_SETTINGS_FIXTURE: JSON.stringify({ model: 'opus[1m]:xhigh' }) },
      JSON.stringify({ model: { display_name: 'Opus 4.8', id: 'claude-opus-4-8' }, effort: 'xhigh' }),
    );
    // display_name 'Opus 4.8' carries no '1m', but the launch spec opus[1m] is the SAME family → [1m] applies.
    expect(out).toContain('🧠 opus[1m]·xhigh');
  });

  it('#1: with NO live model piped, the label falls back wholly to the launch settings.model', () => {
    const out = render(
      quietGlance,
      { PAPERCUSP_STATUSLINE_SETTINGS_FIXTURE: JSON.stringify({ model: 'sonnet[1m]:high', effortLevel: 'high' }) },
      '{}',
    );
    expect(out).toContain('🧠 sonnet[1m]·high');
  });
});

describe('statusline-fleet OS title — multi-fleet identity (WI-1963)', () => {
  const base = {
    ok: true,
    wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
    bees: { running: 0 },
    governor: { anyPaused: false, paused: [] },
    activity: [],
    tips: [],
  };

  it('renders one 👑 name + colour-square chip per LED fleet, leading the title', () => {
    const title = titleOf({
      ...base,
      self: {
        objective: null,
        fleets: [
          { slug: 'roman-fleet', label: 'roman', role: 'leader', square: '🟪' },
          { slug: 'greek-fleet', label: 'greek', role: 'leader', square: '🟩' },
        ],
      },
    });
    expect(title).toContain('👑 roman 🟪');
    expect(title).toContain('👑 greek 🟩');
    expect(title.startsWith('👑 roman 🟪')).toBe(true); // fleets LEAD the title
    expect(title).toContain('su-me'); // the existing id chip still trails
  });

  it('uses 👤 for a member fleet (non-leader)', () => {
    const title = titleOf({
      ...base,
      self: { fleets: [{ slug: 'blue-fleet', label: 'blue', role: 'member', square: '🟦' }] },
    });
    expect(title).toContain('👤 blue 🟦');
    expect(title).not.toContain('👑');
  });

  it('no fleets → no 👑/👤 in the title (id chip unchanged)', () => {
    const title = titleOf({ ...base, self: { objective: null, fleets: [] } });
    expect(title).not.toContain('👑');
    expect(title).not.toContain('👤');
    expect(title).toContain('su-me');
  });

  it('a missing self.fleets (older operator) → no fleet chips, title fails open', () => {
    const title = titleOf({ ...base, self: { objective: null } });
    expect(title).not.toContain('👑');
    expect(title).not.toContain('👤');
  });

  it('caps at 4 chips with a +N overflow for a many-fleet leader', () => {
    const fleets = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      slug: n,
      label: n,
      role: 'leader',
      square: '🟦',
    }));
    const title = titleOf({ ...base, self: { fleets } });
    expect(title).toContain('+1'); // 4 shown, 1 folded
    expect([...title.matchAll(/👑/g)]).toHaveLength(4);
  });

  it('fleet chips go ONLY to the title, never the visible statusline body', () => {
    const out = render({
      ...base,
      self: { fleets: [{ slug: 'roman', label: 'roman', role: 'leader', square: '🟪' }] },
    });
    expect(out).not.toContain('👑');
    expect(out).not.toContain('🟪');
  });
});
