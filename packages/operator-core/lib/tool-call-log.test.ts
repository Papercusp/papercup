/** Bare tool-call log (deterministic-context-carry P-013) — dedupe, target
 *  extraction, run collapsing, budget fold (errors out-age successes), and the
 *  generational decay ladder. All pure: same input ⇒ same output. */
import { describe, expect, it } from 'vitest';
import {
  collapseToolCallRuns,
  decayToolCalls,
  dedupeToolCalls,
  formatDecayLine,
  formatToolCallLine,
  normalizeToolName,
  primaryTarget,
  renderAgedToolCallLog,
  renderToolCallLog,
  type ToolCallRow,
} from './tool-call-log';

let seq = 0;
const call = (toolName: string, over: Partial<ToolCallRow> = {}): ToolCallRow => ({
  toolName,
  phase: 'post',
  status: 'ok',
  kind: 'tool',
  toolUseId: `u${(seq += 1)}`,
  ...over,
});

describe('normalizeToolName / primaryTarget', () => {
  it('strips the mcp__server__ prefix; native names pass through', () => {
    expect(normalizeToolName('mcp__papercusp-su__coord_send')).toBe('coord_send');
    expect(normalizeToolName('Bash')).toBe('Bash');
    expect(normalizeToolName(null)).toBe('?');
  });

  it('file detail → last two path segments', () => {
    expect(primaryTarget(call('Read', { detail: { file: '/a/b/lib/foo.ts' } }))).toBe('lib/foo.ts');
  });

  it('command detail → cd-prefix stripped and clipped', () => {
    const t = primaryTarget(call('Bash', { detail: { command: 'cd /very/long/repo && npx vitest run x' } }));
    expect(t).toBe('npx vitest run x');
  });

  it('falls back to the glyph-stripped summary; "· name" yields no target', () => {
    expect(primaryTarget(call('Grep', { summary: '🔎 JOURNAL_MARKER' }))).toBe('JOURNAL_MARKER');
    expect(primaryTarget(call('mcp__x__y', { summary: '· mcp__x__y' }))).toBeNull();
  });
});

describe('dedupeToolCalls', () => {
  it('the post row wins its pre; an unmatched pre survives; non-tool rows drop', () => {
    const rows: ToolCallRow[] = [
      { toolName: 'Bash', phase: 'pre', toolUseId: 'a', kind: 'tool' },
      { toolName: 'Bash', phase: 'post', toolUseId: 'a', status: 'ok', kind: 'tool' },
      { toolName: 'Edit', phase: 'pre', toolUseId: 'b', kind: 'tool' }, // never completed
      { toolName: 'x', phase: 'post', kind: 'lifecycle' },
    ];
    const out = dedupeToolCalls(rows);
    expect(out).toHaveLength(2);
    expect(out[0].phase).toBe('post');
    expect(out[1].toolName).toBe('Edit');
  });
});

describe('formatToolCallLine / collapseToolCallRuns', () => {
  it('renders name + target + outcome glyph (· for unknown)', () => {
    expect(formatToolCallLine(call('Edit', { detail: { file: '/r/lib/a.ts' } })).text).toBe('Edit lib/a.ts ✓');
    expect(formatToolCallLine(call('Bash', { status: 'error', detail: { command: 'npm test' } })).text).toBe(
      'Bash npm test ✗',
    );
    expect(formatToolCallLine(call('coord_send', { status: null })).text).toBe('coord_send ·');
  });

  it('collapses a same-tool-same-outcome run with up to 3 distinct targets, +N beyond', () => {
    const run = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((f) => call('Read', { detail: { file: `/r/${f}` } }));
    const lines = collapseToolCallRuns(run);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Read ×5 (r/a.ts, r/b.ts, r/c.ts, +2) ✓');
    expect(lines[0].calls).toBe(5);
  });

  it('an ERROR call never collapses — it breaks the run and keeps its own line', () => {
    const rows = [
      call('Bash', { detail: { command: 'run 1' } }),
      call('Bash', { detail: { command: 'run 2' } }),
      call('Bash', { status: 'error', detail: { command: 'run 3' } }),
      call('Bash', { detail: { command: 'run 4' } }),
    ];
    const lines = collapseToolCallRuns(rows);
    expect(lines.map((l) => l.text)).toEqual(['Bash ×2 (run 1, run 2) ✓', 'Bash run 3 ✗', 'Bash run 4 ✓']);
  });
});

describe('decayToolCalls / formatDecayLine', () => {
  it('aggregates per-tool counts (errors marked) + top-K touched-set, deterministically ordered', () => {
    const rows = [
      call('Bash', { detail: { command: 'x' } }),
      call('Bash', { status: 'error', detail: { command: 'y' } }),
      call('Read', { detail: { file: '/r/a.ts' } }),
      call('Read', { detail: { file: '/r/a.ts' } }),
      call('Edit', { detail: { file: '/r/b.ts' } }),
    ];
    const d = decayToolCalls(rows, 2);
    expect(d.counts).toEqual([
      { tool: 'Bash', n: 2, errors: 1 },
      { tool: 'Read', n: 2, errors: 0 },
      { tool: 'Edit', n: 1, errors: 0 },
    ]);
    expect(d.topTargets).toEqual(['r/a.ts', 'r/b.ts']); // by frequency, then name
    expect(formatDecayLine(d)).toBe('5 calls: Bash×2(1✗) Read×2 Edit×1 · touched: r/a.ts, r/b.ts');
  });
});

describe('renderToolCallLog (budget fold: errors out-age successes)', () => {
  it('within budget renders plain lines, no decay header', () => {
    const out = renderToolCallLog([call('Edit', { detail: { file: '/r/a.ts' } })]);
    expect(out).toBe('Edit r/a.ts ✓');
  });

  it('over budget folds OLDEST SUCCESSES into an [aged] decay line, keeping errors + newest', () => {
    const rows: ToolCallRow[] = [];
    // 10 alternating-tool successes (no run collapse), an early error, then 2 more.
    rows.push(call('Bash', { status: 'error', detail: { command: 'boom' } }));
    for (let i = 0; i < 10; i += 1) {
      rows.push(call(i % 2 ? 'Read' : 'Edit', { detail: { file: `/r/f${i}.ts` } }));
    }
    const out = renderToolCallLog(rows, { maxLines: 5 });
    const lines = out.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\[aged\] 7 calls: /); // 11 lines - (4 kept) = 7 folded
    expect(lines[1]).toBe('Bash boom ✗'); // the error out-ages every older success
    expect(lines[4]).toBe('Read r/f9.ts ✓'); // the newest call is the last line
  });

  it('is deterministic and returns empty for no calls', () => {
    const rows = [call('Bash', { detail: { command: 'a' } }), call('Read', { detail: { file: '/r/x.ts' } })];
    expect(renderToolCallLog(rows)).toBe(renderToolCallLog(rows));
    expect(renderToolCallLog([])).toBe('');
  });
});

describe('renderAgedToolCallLog (the generational ladder)', () => {
  it('gen-0 itemized; gen-1 decays successes but keeps errors itemized; gen-2 counts only', () => {
    const gen0 = [call('Edit', { detail: { file: '/r/now.ts' } })];
    const gen1 = [
      call('Read', { detail: { file: '/r/old.ts' } }),
      call('Bash', { status: 'error', detail: { command: 'failed thing' } }),
    ];
    const gen2 = [
      call('Bash', { status: 'error', detail: { command: 'ancient fail' } }),
      call('Read', { detail: { file: '/r/ancient.ts' } }),
    ];
    const out = renderAgedToolCallLog([gen0, gen1, gen2]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Edit r/now.ts ✓');
    expect(lines[1]).toBe('[gen-1] 1 calls: Read×1 · touched: r/old.ts');
    expect(lines[2]).toBe('[gen-1] Bash failed thing ✗'); // error out-ages one rung further
    expect(lines[3]).toBe('[gen-2] 2 calls: Bash×1(1✗) Read×1 · touched: ancient fail, r/ancient.ts');
    expect(lines).toHaveLength(4);
  });

  it('skips empty generations', () => {
    expect(renderAgedToolCallLog([[], [call('Read', { detail: { file: '/r/a.ts' } })]])).toBe(
      '[gen-1] 1 calls: Read×1 · touched: r/a.ts',
    );
  });
});
