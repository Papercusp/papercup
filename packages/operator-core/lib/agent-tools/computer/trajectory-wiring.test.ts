/**
 * trajectory-wiring.test.ts — the P-009 recorder as it is actually reached: through
 * `runComputerAction` and `runClickElement`, with the injected exec seam and no X.
 *
 * These are the tests a passing recorder would NOT give you. The recorder's own
 * suite proves it writes frames; this one proves the two properties that make the
 * feature correct rather than merely present:
 *
 *   D-013 §2 — a recording adds NOTHING to the tool result. If it ever did, P-008's
 *              whole token-hygiene win would be quietly undone by turning recording
 *              on, and every test in computer.test.ts would still pass.
 *   D-013 §2 — a step whose observation already produced pixels costs ONE capture,
 *              and the recorded frame is byte-identical to what the model saw.
 *   D-013 §4 — computer:click_element lands on the ledger (and in the recording),
 *              so the AT-SPI path is not the unrecorded one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runComputerAction,
  __setComputerExecForTests,
  __resetComputerExec,
  type ComputerExec,
} from './computer';
import { runClickElement } from './observe';
import { ATSPI_SENTINEL } from './accessibility-tree';
import { __resetAllLedgersForTests, readLedger } from './action-ledger';
import {
  __resetRecordingsForTests,
  readRecording,
  startRecording,
  stopRecording,
} from './trajectory-recorder';

const DISPLAY = ':987';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, 5)]);

interface Call {
  bin: string;
  args: string[];
}

/**
 * A fake desktop with NO accessibility bus, so `observe:'auto'` falls back to pixels
 * — and one WITH a bus when `bus` is set, so the tree branch is exercised.
 */
function fakeExec(opts: { bus?: boolean; actionOk?: boolean; clickStatus?: number } = {}): {
  exec: ComputerExec;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: ComputerExec = async (bin, args) => {
    calls.push({ bin, args });
    if (bin === 'import') return { status: 0, stdout: PNG, stderr: '' };
    if (bin === 'xprop') {
      return opts.bus
        ? { status: 0, stdout: Buffer.from("AT_SPI_BUS(STRING) = \"unix:path=/run/fake-bus\""), stderr: '' }
        : { status: 0, stdout: Buffer.from('no such atom on any window.'), stderr: '' };
    }
    if (bin === 'gjs') {
      const payload = JSON.stringify({ ok: opts.actionOk ?? true, performed: 'click', role: 'push button', name: 'Save' });
      return { status: 0, stdout: Buffer.from(`${ATSPI_SENTINEL}${payload}`), stderr: '' };
    }
    if (bin === 'xdotool') return { status: opts.clickStatus ?? 0, stdout: Buffer.alloc(0), stderr: 'boom' };
    return { status: 0, stdout: Buffer.alloc(0), stderr: '' };
  };
  return { exec, calls };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-wire-'));
  process.env.PAPERCUSP_COMPUTER_DISPLAY = DISPLAY;
  process.env.PAPERCUSP_COMPUTER_WIDTH = '1024';
  process.env.PAPERCUSP_COMPUTER_HEIGHT = '768';
  __resetAllLedgersForTests();
});

afterEach(() => {
  __resetComputerExec();
  __resetRecordingsForTests();
  rmSync(root, { recursive: true, force: true });
  delete process.env.PAPERCUSP_COMPUTER_DISPLAY;
  delete process.env.PAPERCUSP_COMPUTER_WIDTH;
  delete process.env.PAPERCUSP_COMPUTER_HEIGHT;
});

describe('capability:computer with a recording open', () => {
  it('adds NOTHING to the tool result — the recording is invisible in context (D-013 §2)', async () => {
    const { exec } = fakeExec();
    __setComputerExecForTests(exec);

    const before = await runComputerAction({ action: 'left_click', coordinate: [10, 20], observe: 'none' });
    startRecording({ display: DISPLAY, root });
    const during = await runComputerAction({ action: 'left_click', coordinate: [10, 20], observe: 'none' });

    // Same shape, same content kinds — and above all, still no image block.
    expect(during.content.map((c) => c.type)).toEqual(before.content.map((c) => c.type));
    expect(during.content.some((c) => c.type === 'image')).toBe(false);
    expect(JSON.stringify(during.content).length).toBeLessThanOrEqual(JSON.stringify(before.content).length + 4);
  });

  it('costs ZERO captures while no recording is open', async () => {
    const { exec, calls } = fakeExec();
    __setComputerExecForTests(exec);
    await runComputerAction({ action: 'left_click', coordinate: [1, 2], observe: 'none' });
    expect(calls.filter((c) => c.bin === 'import')).toHaveLength(0);
  });

  it('captures exactly once per step when the observation produced no pixels', async () => {
    const { exec, calls } = fakeExec();
    __setComputerExecForTests(exec);
    const rec = startRecording({ display: DISPLAY, root });
    await runComputerAction({ action: 'left_click', coordinate: [1, 2], observe: 'none' });
    expect(calls.filter((c) => c.bin === 'import')).toHaveLength(1);
    expect(readRecording(rec.dir).frames).toHaveLength(1);
  });

  it('REUSES the observation image — one capture, and the frame is byte-identical (D-013 §2)', async () => {
    const { exec, calls } = fakeExec();
    __setComputerExecForTests(exec);
    const rec = startRecording({ display: DISPLAY, root });

    const result = await runComputerAction({ action: 'left_click', coordinate: [3, 4], observe: 'image' });

    expect(calls.filter((c) => c.bin === 'import')).toHaveLength(1);
    const loaded = readRecording(rec.dir);
    expect(loaded.frames).toHaveLength(1);
    expect(loaded.frames[0]!.reused).toBe(true);

    const shot = result.content.find((c) => c.type === 'image') as { data: string };
    expect(readFileSync(join(rec.dir, loaded.frames[0]!.file))).toEqual(Buffer.from(shot.data, 'base64'));
  });

  it('records a FAILED action — that frame is the one a reviewer wants', async () => {
    const { exec } = fakeExec({ clickStatus: 1 });
    __setComputerExecForTests(exec);
    const rec = startRecording({ display: DISPLAY, root });
    const result = await runComputerAction({ action: 'left_click', coordinate: [5, 6], observe: 'none' });
    expect(result.isError).toBe(true);
    const loaded = readRecording(rec.dir);
    expect(loaded.frames).toHaveLength(1);
    expect(loaded.frames[0]!.line).toContain('FAILED');
  });

  it('keeps recording across a `wait`, and stops recording after stopRecording', async () => {
    const { exec } = fakeExec();
    __setComputerExecForTests(exec);
    const rec = startRecording({ display: DISPLAY, root });
    await runComputerAction({ action: 'wait', duration: 0.01, observe: 'none' });
    stopRecording(DISPLAY);
    await runComputerAction({ action: 'left_click', coordinate: [7, 8], observe: 'none' });
    expect(readRecording(rec.dir).frames).toHaveLength(1);
  });
});

describe('computer:click_element (D-013 §4)', () => {
  it('writes a ledger entry and emits its line — the AT-SPI path is no longer unrecorded', async () => {
    const { exec } = fakeExec({ bus: true, actionOk: true });
    __setComputerExecForTests(exec);

    const result = await runClickElement({ ref: '0/0/2/1' });
    const text = (result.content[0] as { text: string }).text;

    expect(text).toMatch(/^#1 click_element #0\/0\/2\/1 ok/);
    expect(text).toContain('Activated push button "Save"');
    const ledger = readLedger(DISPLAY);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.action).toBe('click_element #0/0/2/1');
  });

  it('lands in an open recording, so a tree-driven trajectory has frames with actions', async () => {
    const { exec, calls } = fakeExec({ bus: true, actionOk: true });
    __setComputerExecForTests(exec);
    const rec = startRecording({ display: DISPLAY, root });

    await runClickElement({ ref: '0/0/2/1' });

    const loaded = readRecording(rec.dir);
    expect(loaded.frames).toHaveLength(1);
    expect(loaded.frames[0]!.line).toContain('click_element');
    // The activation returns no pixels, so exactly one capture happened for it.
    expect(calls.filter((c) => c.bin === 'import')).toHaveLength(1);
  });

  it('shares the ledger sequence with capability:computer', async () => {
    const { exec } = fakeExec({ bus: true, actionOk: true });
    __setComputerExecForTests(exec);
    await runComputerAction({ action: 'left_click', coordinate: [1, 1], observe: 'none' });
    const result = await runClickElement({ ref: '0/0/2/1' });
    expect((result.content[0] as { text: string }).text).toMatch(/^#2 click_element/);
  });
});
