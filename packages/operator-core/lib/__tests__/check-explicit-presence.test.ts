/**
 * check-explicit-presence.test.ts — the WI-6004 zero-value-defaulting-at-a-
 * parse/deserialize-boundary detector (the "mechanical" half of WI-5977,
 * "Adopt explicit-presence as an enforced convention...").
 *
 * The incident class: a layer that cannot tell "absent" from "measured zero"
 * silently picks the type's zero value instead of erroring — udxRelayed absent
 * read as `relayed:false`, bytesReceived absent read as `0`. This locks the
 * analyzer's precision (mirrors check-declared-deps-extracted.test.ts's shape:
 * import the pure function from the .mjs script directly rather than
 * duplicating its logic here):
 *   1. it FLAGS the exact incident shapes (a direct JSON.parse(...).field
 *      chain; a tracked JSON.parse'd / sql-row variable's field, within the
 *      lookback window; an IPC/event payload field) defaulted via `??`/`||`
 *      to a zero-ish value;
 *   2. it does NOT false-positive on a bare untracked local var default, a
 *      non-zero sentinel default, an already-correct explicit-presence check,
 *      test files, or comments;
 *   3. a tracked boundary variable's scope decays outside the lookback
 *      window — the whole-FILE gate this replaced measured 1264 hits on the
 *      real tree (mostly unrelated reads far from the nearest JSON.parse
 *      call); this locks that the locality narrowing actually holds.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its analyzer only.
import { analyzeForExplicitPresence } from '../../../../scripts/check-explicit-presence.mjs';

describe('analyzeForExplicitPresence (WI-6004)', () => {
  it('flags a direct JSON.parse(...).field chain defaulted to a zero value — the udxRelayed shape', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/a.ts',
      text: 'const relayed = JSON.parse(raw).udxRelayed ?? false;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].reason).toMatch(/udxRelayed\/bytesReceived incident shape/);
  });

  it('flags `?? 0` off a direct JSON.parse chain — the bytesReceived shape', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/b.ts',
      text: 'const bytesReceived = JSON.parse(logLine).bytesReceived ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
  });

  it('flags a field read on a variable this file assigned from JSON.parse, within the lookback window', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/c.ts',
      text: 'const parsed = JSON.parse(raw);\nconst count = parsed.count ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/assigned from JSON\.parse at line 1/);
  });

  it('flags a field read on a sql-tagged query result — a NULL DB column read as zero', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/d.ts',
      text: 'const rows = await sql`select active from t`;\nconst active = rows[0].active ?? false;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/DB row/);
  });

  it('flags an IPC/event-payload field defaulted with `||`', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/e.ts',
      text: "ipcRenderer.on('reply', (event, payload) => {\n  const n = payload.count || 0;\n});\n",
    });
    expect(hits).toHaveLength(1);
  });

  it('does NOT flag a bare untracked local variable default — far too generic to be a boundary read', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/f.ts',
      text: "const debugEnabled = config.debug ?? false;\n",
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a non-zero sentinel default even off a direct JSON.parse chain', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/g.ts',
      text: "const name = JSON.parse(raw).name ?? 'unknown';\n",
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag an already-correct explicit-presence check (an `in` guard, no risky default)', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/h.ts',
      text: "const p = JSON.parse(raw);\nconst relayed = 'udxRelayed' in p ? p.udxRelayed : ABSENT;\n",
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a test file, regardless of content', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/i.test.ts',
      text: 'const relayed = JSON.parse(raw).udxRelayed ?? false;\n',
    });
    expect(hits).toHaveLength(0);
  });

  it('does NOT flag a commented-out example of the risky shape', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/j.ts',
      text: "const rows = await sql`select 1`;\n// const active = rows[0].active ?? false; (old approach)\n",
    });
    expect(hits).toHaveLength(0);
  });

  it('a tracked boundary variable decays OUTSIDE the lookback window (the locality narrowing that replaced the 1264-hit whole-file gate)', () => {
    const near = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/k-near.ts',
      text: 'const row = await sql`select status from t`;\n' + '// pad\n'.repeat(10) + 'const status = row.status ?? false;\n',
    });
    expect(near).toHaveLength(1);

    const far = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/k-far.ts',
      text: 'const row = await sql`select status from t`;\n' + '// pad\n'.repeat(60) + 'const status = row.status ?? false;\n',
    });
    expect(far).toHaveLength(0);
  });

  it('the reported hit carries a stable shape (line, snippet, reason) for the CLI reporter', () => {
    const hits = analyzeForExplicitPresence({
      path: 'packages/operator-core/lib/x/l.ts',
      text: 'const parsed = JSON.parse(raw);\nconst tokens = parsed.tokens ?? 0;\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2 });
    expect(typeof hits[0].snippet).toBe('string');
    expect(typeof hits[0].reason).toBe('string');
  });
});
