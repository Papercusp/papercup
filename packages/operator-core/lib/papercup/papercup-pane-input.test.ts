/**
 * papercup-pane-input unit tests (EI-10563): the shared Sentinel-pane write
 * primitive had zero coverage of its own, and the `spoken` tag is the whole
 * fix — a voice-origin turn must land in the pane prefixed `VOICE_TURN_PREFIX`
 * so the persona can key on it deterministically instead of guessing modality
 * from bare text (mirroring the `[deep-answer WI-NNN]` pattern it already
 * keys on reliably, per papercup-deep-watch.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (err: unknown, res?: { stdout: string; stderr: string }) => void;

const execFileCalls: { file: string; args: string[] }[] = [];
/** Per-test override: action-name (the zellij subcommand) -> stdout to return. */
let stdoutByAction: Record<string, string> = {};

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    execFileCalls.push({ file, args });
    const action = args.includes('action') ? args[args.indexOf('action') + 1] : args[0];
    const stdout = stdoutByAction[action as string] ?? '';
    callback(null, { stdout, stderr: '' });
  },
}));

vi.mock('node:fs', () => ({
  existsSync: () => false, // no ~/.cargo/bin/zellij — fall back to bare 'zellij'
  readFileSync: () => 'pui-dock-abc paneId-123',
  statSync: () => ({ mtimeMs: Date.now() - 60_000 }), // well past the warm-up window
}));

// Imported AFTER the mocks are registered (hoisted by vitest regardless of position,
// but kept below for readability).
const { writeToSentinelPane, VOICE_TURN_PREFIX } = await import('./papercup-pane-input');

function writeCharsPayload(): string | undefined {
  const call = execFileCalls.find((c) => c.args.includes('write-chars'));
  // args: ['-s', session, 'action', 'write-chars', '--pane-id', paneId, '--', <payload>]
  return call?.args[call.args.length - 1];
}

describe('writeToSentinelPane — the EI-10563 voice-tag', () => {
  afterEach(() => {
    execFileCalls.length = 0;
    stdoutByAction = {};
  });

  it('writes the raw line untagged when spoken is omitted', async () => {
    stdoutByAction['ls'] = 'pui-dock-abc\n';
    stdoutByAction['dump-screen'] = 'a normal composer, nothing held';

    const res = await writeToSentinelPane('status of the hive');

    expect(res.ok).toBe(true);
    expect(writeCharsPayload()).toBe('status of the hive');
  });

  it('writes the raw line untagged when spoken is explicitly false', async () => {
    stdoutByAction['ls'] = 'pui-dock-abc\n';
    stdoutByAction['dump-screen'] = 'a normal composer, nothing held';

    const res = await writeToSentinelPane('typed text', { spoken: false });

    expect(res.ok).toBe(true);
    expect(writeCharsPayload()).toBe('typed text');
  });

  it('tags the line with VOICE_TURN_PREFIX when spoken is true', async () => {
    stdoutByAction['ls'] = 'pui-dock-abc\n';
    stdoutByAction['dump-screen'] = 'a normal composer, nothing held';

    const res = await writeToSentinelPane('status of the hive', { spoken: true });

    expect(res.ok).toBe(true);
    expect(writeCharsPayload()).toBe(`${VOICE_TURN_PREFIX} status of the hive`);
  });

  it('never tags when the pane is unavailable (no live dock) — no write happens at all', async () => {
    stdoutByAction['ls'] = ''; // no live pui-dock-* sessions

    const res = await writeToSentinelPane('hello', { spoken: true });

    expect(res).toEqual({ ok: false, reason: 'no-dock', error: 'no live pui-dock session' });
    expect(writeCharsPayload()).toBeUndefined();
  });
});
