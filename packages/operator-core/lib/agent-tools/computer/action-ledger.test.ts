/**
 * P-008 / D-012 — the action ledger and the post-action observation decision table.
 *
 * The two properties worth guarding are the ones a green suite would otherwise be
 * silent about:
 *   1. a result contributes exactly ONE line and never re-emits history (the
 *      O(N²) trap D-012 exists to avoid), and
 *   2. `auto` falls back to PIXELS rather than to blindness whenever the tree
 *      cannot see the screen — with a deliberately-wrong control proving the
 *      assertions can fail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordAction,
  renderLedgerLine,
  readLedger,
  resetLedger,
  ledgerDisplays,
  LEDGER_RING_SIZE,
  __resetAllLedgersForTests,
  type ActionLedgerEntry,
} from './action-ledger';
import {
  runComputerAction,
  __setComputerExecForTests,
  __resetComputerExec,
  type ComputerExecResult,
} from './computer';
import { ATSPI_SENTINEL } from './accessibility-tree';

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

describe('action ledger', () => {
  beforeEach(() => __resetAllLedgersForTests());

  it('numbers steps monotonically per display, independently', () => {
    recordAction(':110', { action: 'left_click', ok: true, observed: 'tree' });
    recordAction(':110', { action: 'type', ok: true, observed: 'tree' });
    const other = recordAction(':111', { action: 'key', ok: true, observed: 'none' });
    const third = recordAction(':110', { action: 'key', ok: true, observed: 'none' });
    expect(third.seq).toBe(3);
    expect(other.seq).toBe(1);
  });

  it('renders one compact line carrying coordinate, outcome and what was observed', () => {
    const e = recordAction(':110', {
      action: 'left_click',
      coordinate: [412, 388],
      ok: true,
      observed: 'tree',
    });
    expect(renderLedgerLine(e)).toBe('#1 left_click (412,388) ok · tree');
  });

  it('renders a failure as FAILED with its note, and omits `· none`', () => {
    const e = recordAction(':110', { action: 'left_click', ok: false, observed: 'none', note: 'exit 1' });
    expect(renderLedgerLine(e)).toBe('#1 left_click FAILED · exit 1');
  });

  it('records typed text by LENGTH and never echoes the text itself', () => {
    // Stands in for a password typed into a GUI: what matters is that neither the
    // emitted line nor the diagnostics ring can carry the characters back out.
    const typed = 'the quick brown fox jumps';
    const e = recordAction(':110', {
      action: 'type',
      typedChars: typed.length,
      ok: true,
      observed: 'tree',
    });
    const line = renderLedgerLine(e);
    expect(line).toContain('25 chars');
    expect(line).not.toContain(typed);
    expect(JSON.stringify(readLedger(':110'))).not.toContain(typed);
  });

  it('records key chords verbatim (short, and not secrets)', () => {
    const e = recordAction(':110', { action: 'key', keys: 'ctrl+s', ok: true, observed: 'none' });
    expect(renderLedgerLine(e)).toBe('#1 key ctrl+s ok');
  });

  it('bounds the diagnostics ring, keeping the most recent entries', () => {
    for (let i = 0; i < LEDGER_RING_SIZE + 10; i += 1) {
      recordAction(':110', { action: `a${i}`, ok: true, observed: 'none' });
    }
    const kept = readLedger(':110');
    expect(kept).toHaveLength(LEDGER_RING_SIZE);
    expect(kept[kept.length - 1]!.action).toBe(`a${LEDGER_RING_SIZE + 9}`);
    // Sequence numbers keep counting past the ring — `#7` must mean the same
    // thing all session, or a ledger line cannot be correlated with a transcript.
    expect(kept[kept.length - 1]!.seq).toBe(LEDGER_RING_SIZE + 10);
  });

  it('resetLedger drops a display so a recycled display number starts at #1', () => {
    recordAction(':110', { action: 'left_click', ok: true, observed: 'none' });
    resetLedger(':110');
    expect(ledgerDisplays()).not.toContain(':110');
    expect(recordAction(':110', { action: 'left_click', ok: true, observed: 'none' }).seq).toBe(1);
  });

  it('CONTROL: a renderer that dumped the whole ledger would fail the one-line rule', () => {
    // Calibration for the "exactly one line" assertions below: prove that the
    // property they check is one a wrong implementation actually breaks.
    recordAction(':110', { action: 'left_click', ok: true, observed: 'none' });
    recordAction(':110', { action: 'key', ok: true, observed: 'none' });
    const wrong = (entries: readonly ActionLedgerEntry[]) => entries.map(renderLedgerLine).join('\n');
    expect(wrong(readLedger(':110')).split('\n')).toHaveLength(2);
    expect(renderLedgerLine(readLedger(':110')[1]!).split('\n')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Post-action observation (D-012 decision table)
// ---------------------------------------------------------------------------

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

const ok = (stdout: Buffer | string = ''): ComputerExecResult => ({
  status: 0,
  stdout: typeof stdout === 'string' ? Buffer.from(stdout) : stdout,
  stderr: '',
});

const node = (p: string, r: string, n: string, e: [number, number, number, number] | null, a: string[] = []) =>
  ({ p, r, n, s: ['showing', 'visible'], e, a, v: '' });

/**
 * The walker's real output: toolkit chatter, then ONE sentinel line carrying the
 * whole payload. The leading noise is deliberate — parseWalkerOutput takes the LAST
 * sentinel line precisely so init warnings cannot displace the result.
 */
function walkerStdout(): string {
  const payload = {
    ok: true,
    init: 0,
    apps: 1,
    nodes: [
      node('0', 'application', 'probe', null),
      node('0/0', 'frame', 'Probe', [0, 0, 400, 300]),
      node('0/0/0', 'push button', 'Cancel', [10, 20, 80, 30], ['click']),
    ],
  };
  return `Gtk-CRITICAL: some init noise\n${ATSPI_SENTINEL} ${JSON.stringify(payload)}`;
}

/** A successful walk of a bus with nothing registered on it. */
const EMPTY_WALK = `${ATSPI_SENTINEL} ${JSON.stringify({ ok: true, init: 0, apps: 0, nodes: [] })}`;

/**
 * Drive `runComputerAction` with a scripted executor.
 * `bus` / `walker` control what the a11y path finds, so each row of the decision
 * table is reachable without a live X server.
 */
function harness(opts: { bus: string | null; walker: string | null }): void {
  __setComputerExecForTests(async (bin, args) => {
    const joined = args.join(' ');
    // The a11y bus probe reads the display's root window.
    if (bin === 'xprop') {
      return ok(opts.bus ? `AT_SPI_BUS(STRING) = "${opts.bus}"` : '');
    }
    if (bin === 'gjs') return ok(opts.walker ?? '');
    if (bin === 'import' || joined.includes('png:-')) return ok(PNG);
    return ok('');
  });
}

describe('capability:computer post-action observation (D-012)', () => {
  const ctx = { harnessSlug: null } as const;

  beforeEach(() => {
    __resetAllLedgersForTests();
    process.env.PAPERCUSP_COMPUTER_DISPLAY = ':199';
  });
  afterEach(() => {
    __resetComputerExec();
    delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
  });

  const kinds = (r: { content: Array<{ type: string }> }) => r.content.map((c) => c.type);
  const textAt = (r: { content: Array<unknown> }, i: number) => (r.content[i] as { text: string }).text;

  it("observe:'none' returns the ledger line ONLY — no image, no tree", async () => {
    harness({ bus: null, walker: null });
    const r = await runComputerAction(
      { action: 'left_click', coordinate: [10, 10], observe: 'none' },
      ctx,
    );
    expect(kinds(r)).toEqual(['text']);
    expect(textAt(r, 0)).toMatch(/^#1 left_click \(10,10\) ok$/);
  });

  it("observe:'image' returns the line plus pixels even when a tree is available", async () => {
    harness({ bus: 'unix:path=/run/user/1000/at-spi/bus_199', walker: walkerStdout() });
    const r = await runComputerAction(
      { action: 'left_click', coordinate: [10, 10], observe: 'image' },
      ctx,
    );
    expect(kinds(r)).toEqual(['text', 'image']);
    expect(textAt(r, 0)).toContain('· image');
  });

  it("observe:'auto' prefers the TREE when the desktop exposes one", async () => {
    harness({ bus: 'unix:path=/run/user/1000/at-spi/bus_199', walker: walkerStdout() });
    const r = await runComputerAction({ action: 'left_click', coordinate: [10, 10] }, ctx);
    expect(kinds(r)).toEqual(['text', 'text']);
    expect(textAt(r, 0)).toContain('· tree');
    expect(textAt(r, 1)).toContain('Cancel');
  });

  it("observe:'auto' falls back to PIXELS when the display advertises no bus", async () => {
    harness({ bus: null, walker: null });
    const r = await runComputerAction({ action: 'left_click', coordinate: [10, 10] }, ctx);
    expect(kinds(r)).toEqual(['text', 'image']);
    expect(textAt(r, 0)).toContain('· image · no-bus');
  });

  it("observe:'auto' falls back to PIXELS when the bus is there but registers no apps", async () => {
    // The case that matters most: a plain X11 client (xterm), a canvas, a video.
    // The bus answers, the walk succeeds, and it sees nothing — degrading to
    // blindness here would be silent and total.
    harness({ bus: 'unix:path=/run/user/1000/at-spi/bus_199', walker: EMPTY_WALK });
    const r = await runComputerAction({ action: 'left_click', coordinate: [10, 10] }, ctx);
    expect(kinds(r)).toEqual(['text', 'image']);
    expect(textAt(r, 0)).toContain('· image · no-apps');
  });

  it("observe:'auto' falls back to PIXELS when the walker produces nothing parseable", async () => {
    harness({ bus: 'unix:path=/run/user/1000/at-spi/bus_199', walker: 'Gjs-CRITICAL: boom' });
    const r = await runComputerAction({ action: 'left_click', coordinate: [10, 10] }, ctx);
    expect(kinds(r)).toEqual(['text', 'image']);
    expect(textAt(r, 0)).toContain('· image · walker-failed');
  });

  it("observe:'tree' REFUSES out loud rather than silently returning an image", async () => {
    harness({ bus: null, walker: null });
    const r = await runComputerAction(
      { action: 'left_click', coordinate: [10, 10], observe: 'tree' },
      ctx,
    );
    expect(kinds(r)).toEqual(['text', 'text']);
    expect(textAt(r, 1)).toContain("observe:'tree'");
    expect(textAt(r, 1)).toContain("observe:'image'");
  });

  it('the `screenshot` action always returns pixels, whatever `observe` says', async () => {
    harness({ bus: 'unix:path=/run/user/1000/at-spi/bus_199', walker: walkerStdout() });
    const r = await runComputerAction({ action: 'screenshot', observe: 'none' }, ctx);
    expect(kinds(r)).toEqual(['image']);
  });

  it('a failed action records FAILED and takes NO observation at all', async () => {
    __setComputerExecForTests(async (bin) => {
      if (bin === 'xdotool') return { status: 1, stdout: Buffer.alloc(0), stderr: 'no such window' };
      return ok('');
    });
    const r = await runComputerAction({ action: 'left_click', coordinate: [10, 10] }, ctx);
    expect(r.isError).toBe(true);
    expect(kinds(r)).toEqual(['text']);
    expect(textAt(r, 0)).toContain('#1 left_click (10,10) FAILED');
  });

  it('each result carries exactly ONE ledger line — history is never re-emitted', async () => {
    harness({ bus: 'unix:path=/run/user/1000/at-spi/bus_199', walker: walkerStdout() });
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await runComputerAction(
        { action: 'left_click', coordinate: [i, i], observe: 'none' },
        ctx,
      );
      expect(textAt(r, 0).split('\n')).toHaveLength(1);
      seen.push(textAt(r, 0));
    }
    expect(seen).toEqual([
      '#1 left_click (0,0) ok',
      '#2 left_click (1,1) ok',
      '#3 left_click (2,2) ok',
      '#4 left_click (3,3) ok',
    ]);
    // No result repeats an earlier step: the transcript is the ledger.
    expect(seen[3]).not.toContain('#1');
  });

  it('records the coordinate the MODEL used, not a driver-translated one', async () => {
    harness({ bus: null, walker: null });
    await runComputerAction({ action: 'left_click', coordinate: [412, 388], observe: 'none' }, ctx);
    expect(readLedger(':199')[0]!.coordinate).toEqual([412, 388]);
  });
});
