import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  BUDGET,
  HARD_CAP,
  SCHEMA_BYTE_BUDGET,
  type NamedToolWeight,
} from './tool-guidance-budget';
import { FLOOR_HEADROOM_MARGIN_BYTES, summarizeDelivery } from './tool-delivery-policy';
import {
  formatToolWeightReport,
  measureToolWeights,
  parseToolWeightArgs,
  runToolWeightCli,
} from './tool-weight-cli';

const weights: NamedToolWeight[] = [
  { name: 'small:tool', weight: 200 },
  { name: 'over:budget', weight: BUDGET + 7 },
  { name: 'over:hard-cap', weight: HARD_CAP + 4 },
];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TSX = resolve(REPO_ROOT, 'node_modules/.bin/tsx');

describe('tool-weight CLI', () => {
  it('parses a single tool selector and JSON output flag', () => {
    expect(parseToolWeightArgs(['--json', 'over:budget'])).toEqual({
      all: false,
      json: true,
      selector: 'over:budget',
    });
  });

  it('rejects ambiguous selectors', () => {
    expect(() => parseToolWeightArgs(['--all', 'over:budget'])).toThrow(/either --all or a tool name/);
  });

  it('reports the runtime weight and exact trim for a selected tool', () => {
    const rows = measureToolWeights(weights, 'over:budget');
    const report = formatToolWeightReport(rows, weights.length, { selector: 'over:budget' });
    expect(report).toContain(`over:budget: ${BUDGET + 7} chars`);
    expect(report).toContain('cut at least 7 chars');
  });

  it('returns a non-zero status for an unknown runtime tool', () => {
    const error = vi.fn();
    expect(runToolWeightCli(['missing:tool'], weights, vi.fn(), error)).toBe(1);
    expect(error).toHaveBeenCalledWith('No runtime-projected tool named missing:tool');
  });

  it('returns 0 for a tool within budget', () => {
    expect(runToolWeightCli(['small:tool'], weights, vi.fn(), vi.fn())).toBe(0);
  });

  it('returns non-zero for a tool over the HARD CAP (EI-21863941004984235)', () => {
    expect(runToolWeightCli(['over:hard-cap'], weights, vi.fn(), vi.fn())).not.toBe(0);
  });

  it('returns non-zero for a tool over budget but under the hard cap (EI-21863792505619206)', () => {
    expect(runToolWeightCli(['over:budget'], weights, vi.fn(), vi.fn())).not.toBe(0);
  });

  it('returns non-zero on an unfiltered run when any tool in the catalog violates, even outside the printed top-20 slice', () => {
    // The default (no selector, no --all) run prints only the top-20 heaviest
    // rows, but the exit code must reflect the WHOLE catalog, not the slice.
    expect(runToolWeightCli([], weights, vi.fn(), vi.fn())).not.toBe(0);
  });

  it('returns 0 when every tool in the catalog is within budget', () => {
    const cleanWeights: NamedToolWeight[] = [{ name: 'small:tool', weight: 200 }];
    expect(runToolWeightCli([], cleanWeights, vi.fn(), vi.fn())).toBe(0);
  });

  /**
   * The schema tier's "which lever" signal (EI-23379068490085254). The byte total alone
   * sends an author to redesign a schema whose structure was never the bill; the split is
   * what points them at `.describe()` instead.
   */
  describe('argSchema prose share', () => {
    const OVER = SCHEMA_BYTE_BUDGET + 2_000;
    const schemaWeights: NamedToolWeight[] = [
      // Big AND almost all prose — the population the alert exists for (the real ones:
      // coord:send, facts:assert, fleet:launch-on-plan).
      { name: 'prose:heavy', weight: 200, schemaBytes: OVER, schemaProseBytes: OVER * 0.8 },
      // Big but genuinely structural — cutting prose here would not help, so no alert.
      { name: 'prose:light', weight: 200, schemaBytes: OVER, schemaProseBytes: OVER * 0.2 },
      // Prose-dominated but tiny: a small, well-documented schema is what GOOD looks like.
      { name: 'prose:tiny', weight: 200, schemaBytes: 400, schemaProseBytes: 360 },
      // A caller that measured bytes but not prose.
      { name: 'prose:unmeasured', weight: 200, schemaBytes: OVER },
    ];
    const rowsByName = new Map(measureToolWeights(schemaWeights).map((row) => [row.name, row]));

    it('prints the prose/structural split under the argSchema line', () => {
      const report = formatToolWeightReport(
        measureToolWeights(schemaWeights, 'prose:heavy'),
        schemaWeights.length,
        { selector: 'prose:heavy' },
      );
      expect(report).toContain(`argSchema ${OVER} bytes`);
      expect(report).toContain(`prose ${OVER * 0.8} B (80%) · structural ${OVER * 0.2} B`);
    });

    it('flags a big, prose-dominated schema as PROSE-HEAVY', () => {
      expect(rowsByName.get('prose:heavy')?.schemaProseHeavy).toBe(true);
      const report = formatToolWeightReport(
        measureToolWeights(schemaWeights, 'prose:heavy'),
        schemaWeights.length,
        { selector: 'prose:heavy' },
      );
      expect(report).toContain('PROSE-HEAVY');
    });

    it('does not flag a structural schema, nor a small one that is mostly prose', () => {
      expect(rowsByName.get('prose:light')?.schemaProseShare).toBeCloseTo(0.2, 5);
      expect(rowsByName.get('prose:light')?.schemaProseHeavy).toBe(false);
      // 90% prose, but 400 B of it — there is nothing here worth an author's attention.
      expect(rowsByName.get('prose:tiny')?.schemaProseShare).toBeCloseTo(0.9, 5);
      expect(rowsByName.get('prose:tiny')?.schemaProseHeavy).toBe(false);
      const quiet = schemaWeights.filter((t) => t.name !== 'prose:heavy');
      const report = formatToolWeightReport(measureToolWeights(quiet), quiet.length);
      expect(report).toContain('prose 2000 B (20%)');
      expect(report).not.toContain('PROSE-HEAVY');
    });

    it('omits the split entirely when the caller measured no prose — never a 0 B line', () => {
      // A `prose 0 B (0%)` line is indistinguishable from a genuinely structural schema,
      // and "nothing to cut here" is the wrong thing to tell someone hunting bytes.
      const row = rowsByName.get('prose:unmeasured');
      expect(row?.schemaBytes).toBe(OVER);
      expect(row?.schemaProseBytes).toBeUndefined();
      expect(row?.schemaProseShare).toBeUndefined();
      expect(row?.schemaProseHeavy).toBeUndefined();
      const report = formatToolWeightReport(
        measureToolWeights(schemaWeights, 'prose:unmeasured'),
        schemaWeights.length,
        { selector: 'prose:unmeasured' },
      );
      expect(report).toContain(`argSchema ${OVER} bytes`);
      expect(report).not.toContain('prose ');
    });
  });

  /**
   * The edit-time floor-budget signal (WI-10004590). A floor-tool description edit is only
   * caught by psu-launcher.test.ts at gate time; these pin that the CLI surfaces the
   * remaining headroom — and flips to LOW / OVERRUN — before the gate does.
   */
  describe('tool-delivery floor headroom', () => {
    // Two floors seat 600 + 400 = 1000 compact bytes; `other:tool` is a non-floor.
    const catalog = [
      { name: 'floor:a', fullBytes: 900, compactBytes: 600 },
      { name: 'floor:b', fullBytes: 700, compactBytes: 400 },
      { name: 'other:tool', fullBytes: 500, compactBytes: 300 },
    ];
    const deliveryWith = (budgetBytes: number) =>
      summarizeDelivery({
        agentKind: 'claude',
        catalog,
        demand: [],
        floors: ['floor:a', 'floor:b'],
        budgetBytes,
      });
    const toolWeights: NamedToolWeight[] = [
      { name: 'floor:a', weight: 200 },
      { name: 'other:tool', weight: 200 },
    ];
    const run = (args: string[], delivery?: ReturnType<typeof deliveryWith>) => {
      const out: string[] = [];
      const code = runToolWeightCli(args, toolWeights, (t) => out.push(t), vi.fn(), delivery);
      return { code, text: out.join('\n') };
    };

    it('prints the headroom line under the header, and nothing when delivery was not measured', () => {
      const withDelivery = run(['--all'], deliveryWith(1000 + FLOOR_HEADROOM_MARGIN_BYTES + 36));
      expect(withDelivery.text).toContain('floor headroom: OK 100 B of 1100');
      expect(withDelivery.text.split('\n')[1]).toMatch(/^floor headroom:/);
      // A bare fixture run must keep its old shape — no phantom zero-headroom line.
      expect(run(['--all']).text).not.toContain('floor headroom');
    });

    it('flips to LOW below the margin, names the byte count, and stays advisory (exit 0)', () => {
      const lowBudget = 1000 + FLOOR_HEADROOM_MARGIN_BYTES - 1;
      const r = run(['floor:a'], deliveryWith(lowBudget));
      expect(r.text).toContain(`floor headroom: LOW ${FLOOR_HEADROOM_MARGIN_BYTES - 1} B of ${lowBudget}`);
      expect(r.text).toContain(`more than ${FLOOR_HEADROOM_MARGIN_BYTES - 1} B overruns`);
      expect(r.code).toBe(0);
    });

    it('is OK at exactly the margin — the boundary is inclusive of the margin itself', () => {
      const r = run(['floor:a'], deliveryWith(1000 + FLOOR_HEADROOM_MARGIN_BYTES));
      expect(r.text).toContain(`floor headroom: OK ${FLOOR_HEADROOM_MARGIN_BYTES} B`);
    });

    it('reports an OVERRUN and exits non-zero, even for a tool that is not a floor', () => {
      const r = run(['other:tool'], deliveryWith(900));
      expect(r.text).toContain('floor headroom: OVERRUN by 100 B of 900');
      expect(r.code).toBe(1);
    });

    it('labels a FLOOR tool and sizes it for a single-tool query, but not in a listing', () => {
      const delivery = deliveryWith(1100);
      const floor = run(['floor:a'], delivery).text;
      expect(floor).toContain('delivery compact · FLOOR tool (counts against the headroom above)');
      expect(floor).toContain('compact 600 B · full 900 B');
      const plain = run(['other:tool'], delivery).text;
      expect(plain).toContain('not a floor tool');
      expect(plain).toContain('compact 300 B · full 500 B');
      expect(run(['--all'], delivery).text).not.toContain('delivery ');
    });

    it('carries floorHeadroom and per-tool delivery in --json, and omits both without delivery', () => {
      const json = JSON.parse(run(['--json', '--all'], deliveryWith(1010)).text) as {
        floorHeadroom: { headroomBytes: number; status: string };
        tools: Array<{ name: string; delivery?: { isFloor: boolean } }>;
      };
      expect(json.floorHeadroom).toMatchObject({ headroomBytes: 10, status: 'low' });
      expect(json.tools.find((t) => t.name === 'floor:a')?.delivery?.isFloor).toBe(true);
      expect(json.tools.find((t) => t.name === 'other:tool')?.delivery?.isFloor).toBe(false);
      const bare = JSON.parse(run(['--json', '--all']).text) as Record<string, unknown>;
      expect('floorHeadroom' in bare).toBe(false);
    });
  });

  it('preserves a large JSON report when the caller exits immediately (EI-22578574821528569)', () => {
    const cliUrl = pathToFileURL(resolve(REPO_ROOT, 'packages/operator-core/lib/agent-tools/tool-weight-cli.ts')).href;
    const program = [
      `import { runToolWeightCli } from ${JSON.stringify(cliUrl)};`,
      "const weights = Array.from({ length: 2000 }, (_, i) => ({ name: `tool:${i}`, weight: 200 }));",
      "process.exit(runToolWeightCli(['--json', '--all'], weights));",
    ].join('\n');
    const output = execFileSync(TSX, ['--eval', program], {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      timeout: 30_000,
    });

    // A console.log followed by process.exit truncates this report through a pipe;
    // parsing the complete catalog proves the writer and the CLI's exit-status path
    // agree even when the caller exits as soon as the report is produced.
    expect(output.length).toBeGreaterThan(100_000);
    const report = JSON.parse(output.toString('utf8')) as { catalogSize: number; tools: unknown[] };
    expect(report.catalogSize).toBe(2000);
    expect(report.tools).toHaveLength(2000);
  }, 45_000);
});
