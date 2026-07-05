/**
 * status-display.test.ts — the single-source TUI render behind coord:glance's
 * `display` block (tui-status-parity-single-source-2026-07-05). These cases
 * are ported from the per-client render tests (statusline-fleet.test.ts /
 * objective-title-parity.test.ts) that used to guard N embedded copies; the
 * render now lives HERE, once, and the client hooks print it verbatim.
 */
import { describe, expect, it } from 'vitest';
import { fmtInterval, renderStatusDisplay, selfShort } from './status-display';

const SID = 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353';

const activity = [
  { owner_id: 'su-peer-aaaaaa', summary: '✎ catalog.ts', kind: 'tool', created_at: 't' },
  { owner_id: 'su-peer-bbbbbb', summary: '▶ npm test', kind: 'tool', created_at: 't' },
];

const base = {
  ok: true,
  wake: { default: 'auto', stagedTotal: 0, stagedOwners: 0 },
  bees: { running: 0 },
  governor: { anyPaused: false, paused: [] },
  activity: [],
  tips: [],
  self: { objective: null, loop: null, fleets: [] },
};

describe('selfShort', () => {
  it('renders the coord ownerLabel form', () => {
    expect(selfShort(SID)).toBe('su-9859e');
    expect(selfShort('fixture')).toBe('');
    expect(selfShort('')).toBe('');
    expect(selfShort('weirdid')).toBe('weirdid');
  });
});

describe('fmtInterval', () => {
  it('compact labels', () => {
    expect(fmtInterval(30)).toBe('30s');
    expect(fmtInterval(120)).toBe('2m');
    expect(fmtInterval(3600)).toBe('1h');
    expect(fmtInterval(5400)).toBe('1h30m');
    expect(fmtInterval(undefined)).toBe('?');
  });
});

describe('renderStatusDisplay — statusline', () => {
  it('manual mode with staged wakes → full chip row + 💡 tip + ⋯ affordance', () => {
    const d = renderStatusDisplay(
      {
        ...base,
        wake: { default: 'manual', stagedTotal: 2, stagedOwners: 1 },
        bees: { running: 1 },
        activity,
        tips: [
          {
            id: 'wake-mode-manual',
            text: "Wake mode is manual — 2 staged wakes waiting; the queen won't self-drive. Back to auto:",
            command: '/mcp__papercusp-su__tool:coord:wake-mode mode=auto',
          },
        ],
      },
      { ownerId: SID },
    );
    expect(d.statusline).toHaveLength(3);
    expect(d.statusline[0]).toContain('◇ su-9859e');
    expect(d.statusline[0]).toContain('⏸ manual ✉2');
    expect(d.statusline[0]).toContain('☕1');
    expect(d.statusline[0]).toContain('2 peers');
    expect(d.statusline[0]).toContain('◆ aaaaaa ✎ catalog.ts');
    expect(d.statusline[1]).toBe(
      "💡 Wake mode is manual — 2 staged wakes waiting; the queen won't self-drive. Back to auto: /mcp__papercusp-su__tool:coord:wake-mode mode=auto",
    );
    expect(d.statusline[2]).toBe('⋯ run /mcp__papercusp-su__tool:coord:glance for detail');
  });

  it('quiet state → single line, solo, ▶ auto', () => {
    const d = renderStatusDisplay(base, { ownerId: SID });
    expect(d.statusline).toHaveLength(1);
    expect(d.statusline[0]).toContain('▶ auto');
    expect(d.statusline[0]).toContain('solo');
    expect(d.statusline[0]).not.toContain('✉');
    expect(d.statusline[0]).not.toContain('💡');
  });

  it('🔭 objective leads line 1, clipped at 48', () => {
    const long = 'x'.repeat(60);
    const d = renderStatusDisplay({ ...base, self: { ...base.self, objective: long } }, { ownerId: SID });
    expect(d.statusline[0].startsWith('🔭 ')).toBe(true);
    const seg = d.statusline[0].split(' · ')[0];
    expect(seg.length).toBeLessThanOrEqual(2 + 48 + 1); // '🔭 ' + clipped body
    expect(seg.endsWith('…')).toBe(true);
  });

  it('⇢ account chip renders when the gateway knows the routed account', () => {
    const d = renderStatusDisplay(base, { ownerId: SID, account: 'max-pool-3' });
    expect(d.statusline[0]).toContain('⇢ max-pool-3');
  });

  it('loop chip: armed / off / unreachable / absent', () => {
    const on = renderStatusDisplay(
      { ...base, self: { ...base.self, loop: { active: true, intervalSec: 300, reachable: true } } },
      { ownerId: SID },
    );
    expect(on.statusline[0]).toContain('⟳ 5m');
    const off = renderStatusDisplay({ ...base, self: { ...base.self, loop: null } }, { ownerId: SID });
    expect(off.statusline[0]).toContain('⟳ off');
    const dark = renderStatusDisplay(
      { ...base, self: { ...base.self, loop: { active: true, intervalSec: 300, reachable: false } } },
      { ownerId: SID },
    );
    expect(dark.statusline[0]).toContain('⟳ 5m ⚠unreachable');
    const absent = renderStatusDisplay({ ...base, self: { objective: null, fleets: [] } }, { ownerId: SID });
    expect(absent.statusline[0]).not.toContain('⟳');
  });

  it('▣ modes + ctx gauge chips (⚠ at the loud band)', () => {
    const d = renderStatusDisplay(
      { ...base, self: { ...base.self, modes: ['auto', 'ideate'], context: { tokens: 1, limit: 2, pct: 42 } } },
      { ownerId: SID },
    );
    expect(d.statusline[0]).toContain('▣ auto+ideate');
    expect(d.statusline[0]).toContain('ctx 42%');
    const loud = renderStatusDisplay(
      { ...base, self: { ...base.self, context: { tokens: 1, limit: 2, pct: 83 } } },
      { ownerId: SID },
    );
    expect(loud.statusline[0]).toContain('⚠ ctx 83%');
  });

  it('governor pause list clipped to 40', () => {
    const d = renderStatusDisplay(
      {
        ...base,
        governor: {
          anyPaused: true,
          paused: [{ key: 'anthropic:opus-very-long-bucket-name' }, { key: 'anthropic:sonnet-also-long' }],
        },
      },
      { ownerId: SID },
    );
    const seg = d.statusline[0].split(' · ').find((s) => s.startsWith('⏳'));
    expect(seg).toBeDefined();
    expect(seg!.length).toBeLessThanOrEqual(40);
  });

  it('no ownerId (fixture) → no ◇ chip, peers still counted', () => {
    const d = renderStatusDisplay({ ...base, activity }, {});
    expect(d.statusline[0]).not.toContain('◇');
    expect(d.statusline[0]).toContain('2 peers');
  });
});

describe('renderStatusDisplay — title', () => {
  it('carries the full compact identity: fleets · loop · wake · bees · peers · id · objective', () => {
    const d = renderStatusDisplay(
      {
        ...base,
        wake: { default: 'manual', stagedTotal: 4, stagedOwners: 2 },
        bees: { running: 2 },
        activity,
        self: {
          objective: 'Resume Linux release readiness (WI-2902)',
          loop: { active: true, intervalSec: 60, reachable: true },
          fleets: [{ slug: 'windows-parity', label: 'windows-parity', role: 'leader', square: '🟦' }],
        },
      },
      { ownerId: SID },
    );
    expect(d.title).toContain('👑 windows-parity 🟦');
    expect(d.title).toContain('⟳1m');
    expect(d.title).toContain('⏸ ✉4');
    expect(d.title).toContain('☕2');
    expect(d.title).toContain('2p');
    expect(d.title).toContain('su-9859e');
    expect(d.title).toContain('🔭 Resume Linux release readiness (WI-2902)');
  });

  it('unreachable loop marks the title tag with !', () => {
    const d = renderStatusDisplay(
      { ...base, self: { ...base.self, loop: { active: true, intervalSec: 300, reachable: false } } },
      { ownerId: SID },
    );
    expect(d.title).toContain('⟳5m!');
  });

  it('fleet chips cap at 4 with +N overflow and 16-char name clip', () => {
    const fleets = Array.from({ length: 6 }, (_, i) => ({
      slug: `fleet-${i}`,
      label: `a-very-long-fleet-name-${i}`,
      role: i === 0 ? 'leader' : 'member',
      square: '🟩',
    }));
    const d = renderStatusDisplay({ ...base, self: { ...base.self, fleets } }, { ownerId: SID });
    expect(d.title).toContain('+2');
    expect(d.title).toContain('👑 a-very-long-fle…');
    expect(d.title).toContain('👤');
  });

  it('strips control chars that could break the OSC escape', () => {
    const d = renderStatusDisplay(
      { ...base, self: { ...base.self, objective: 'evil\x1b]0;pwn\x07 objective' } },
      { ownerId: SID },
    );
    expect(d.title).not.toContain('\x1b');
    expect(d.title).not.toContain('\x07');
  });

  it('title objective clips at 40', () => {
    const d = renderStatusDisplay(
      { ...base, self: { ...base.self, objective: 'y'.repeat(60) } },
      { ownerId: SID },
    );
    const seg = d.title.split(' · ').find((s) => s.startsWith('🔭'));
    expect(seg).toBeDefined();
    expect(seg!.endsWith('…')).toBe(true);
    expect(seg!.length).toBeLessThanOrEqual(2 + 40 + 1);
  });
});

describe('renderStatusDisplay — notice', () => {
  it('top tip becomes an injectable notice with the slash prefix stripped', () => {
    const d = renderStatusDisplay(
      {
        ...base,
        tips: [
          {
            id: 'wake-mode-manual',
            text: 'Wake mode is manual — back to auto:',
            command: '/mcp__papercusp-su__tool:coord:wake-mode mode=auto',
          },
        ],
      },
      { ownerId: SID },
    );
    expect(d.notice).toEqual({
      id: 'wake-mode-manual',
      text: '💡 Wake mode is manual — back to auto: coord:wake-mode mode=auto',
    });
  });

  it('no tips → null notice, no 💡/⋯ lines', () => {
    const d = renderStatusDisplay(base, { ownerId: SID });
    expect(d.notice).toBeNull();
    expect(d.statusline.some((l) => l.startsWith('💡') || l.startsWith('⋯'))).toBe(false);
  });

  it('command-less tip renders text alone', () => {
    const d = renderStatusDisplay(
      { ...base, tips: [{ id: 'governor-paused', text: 'Rate governor paused (x) — turns queue', command: null }] },
      { ownerId: SID },
    );
    expect(d.notice).toEqual({ id: 'governor-paused', text: '💡 Rate governor paused (x) — turns queue' });
    expect(d.statusline[1]).toBe('💡 Rate governor paused (x) — turns queue');
  });
});
