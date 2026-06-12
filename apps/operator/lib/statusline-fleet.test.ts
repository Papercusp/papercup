/**
 * statusline-fleet.test.ts — the fleet statusline's render logic, driven
 * through the script's PAPERCUSP_STATUSLINE_FIXTURE sync mode (no operator, no
 * token). Asserts the two-line glance render (wake glyph / staged ✉ / 🐝 /
 * governor ⏳ / peers / 💡 tip) and the quiet-state single line.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../scripts/hooks/cc/statusline-fleet.sh');
const dir = mkdtempSync(join(tmpdir(), 'statusline-fixture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(glance: unknown, extraEnv: Record<string, string> = {}): string {
  const fixture = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixture, JSON.stringify(glance));
  return execFileSync('bash', [SCRIPT], {
    encoding: 'utf8',
    input: '{}',
    env: {
      ...process.env,
      PAPERCUSP_STATUSLINE_FIXTURE: fixture,
      PAPERCUSP_SID: 'su-me',
      COLUMNS: '200',
      ...extraEnv,
    },
  });
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
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('papercusp');
    expect(lines[0]).toContain('⏸ manual ✉2');
    expect(lines[0]).toContain('🐝1');
    expect(lines[0]).toContain('2 peers');
    expect(lines[0]).toContain('◆ aaaaaa ✎ catalog.ts');
    expect(lines[1]).toBe(
      "💡 Wake mode is manual — 2 staged wakes waiting; the queen won't self-drive. Back to auto: /mcp__papercusp-su__tool:coord:wake-mode mode=auto",
    );
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
    expect(lines.length).toBeLessThanOrEqual(5); // fleet row + ≤4 tip rows
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
    expect(out).toContain('papercusp');
    expect(out).toContain('2 peers');
    expect(out).not.toContain('💡');
  });

  it('garbage fixture prints nothing and exits 0', () => {
    expect(render([1, 2, 3])).toBe('');
  });
});
