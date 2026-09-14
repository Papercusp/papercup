/**
 * mark-terminal.test.ts — coord:mark-terminal (EI-19948333346987654).
 *
 * Pins the two-path best-effort delivery + the tty-claim guard:
 *   - no presence row for the target ownerId -> landed:false, loud reason
 *   - psu-pty IPC path succeeds -> via:'psu-pty', no fs write attempted
 *   - psu-pty fails + no tty recorded on presence -> landed:false, loud reason
 *   - psu-pty fails + tty recorded but claimed by a DIFFERENT owner -> refuses
 *     the write (never mismarks a recycled pty minor number, EI-10377 pattern)
 *   - psu-pty fails + tty recorded + no claim file on record -> fails OPEN and
 *     writes (claim file is a best-effort safety net, not a hard gate)
 *   - psu-pty fails + tty recorded + claimed by the SAME owner -> writes the
 *     OSC title escape to the recorded tty path
 *   - the direct-write path itself throwing -> landed:false, loud reason
 * All outcomes are reported, never thrown — mark-terminal is purely cosmetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getPresence = vi.fn();
vi.mock('../presence', () => ({ getPresence: (ownerId: string) => getPresence(ownerId) }));

const recolorViaPty = vi.fn();
vi.mock('../../../events/await/psu-pty-discovery', () => ({
  recolorViaPty: (ownerId: string, osc: string) => recolorViaPty(ownerId, osc),
}));

const readFile = vi.fn();
const writeFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  readFile: (...a: unknown[]) => readFile(...a),
  writeFile: (...a: unknown[]) => writeFile(...a),
}));

const tool = (await import('./mark-terminal')).default;
const run = async (args: unknown) =>
  ((await tool.handler(args as never, {} as never)) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('coord:mark-terminal', () => {
  it('routes real focus requests to coord:focus-window before this title-only fallback', () => {
    expect(tool.description).toMatch(/does NOT focus or raise/i);
    expect(tool.description).toMatch(/coord:focus-window/);
    expect(tool.guidance?.when).toMatch(/activation through coord:focus-window failed/i);
  });

  it('no presence row for the ownerId -> landed:false with a loud reason', async () => {
    getPresence.mockResolvedValue(null);
    recolorViaPty.mockResolvedValue(false);
    const b = await run({ ownerId: 'su-ghost' });
    expect(b).toMatchObject({ ok: false, landed: false, via: null });
    expect(String(b.reason)).toMatch(/no presence row/);
    expect(recolorViaPty).toHaveBeenCalledWith('su-ghost', expect.stringContaining('FIND ME'));
    expect(recolorViaPty.mock.invocationCallOrder[0]).toBeLessThan(getPresence.mock.invocationCallOrder[0]);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('live psu-pty IPC path succeeds even when the owner has no presence row', async () => {
    getPresence.mockResolvedValue(null);
    recolorViaPty.mockResolvedValue(true);
    const b = await run({ ownerId: 'su-ghost' });
    expect(b).toMatchObject({ ok: true, landed: true, via: 'psu-pty' });
    expect(recolorViaPty).toHaveBeenCalledWith('su-ghost', expect.stringContaining('FIND ME'));
    expect(getPresence).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('psu-pty IPC path succeeds -> via:"psu-pty", never falls through to a raw tty write', async () => {
    getPresence.mockResolvedValue({ ownerId: 'su-a', tty: '/dev/pts/5' });
    recolorViaPty.mockResolvedValue(true);
    const b = await run({ ownerId: 'su-a', label: 'come find me' });
    expect(b).toMatchObject({ ok: true, landed: true, via: 'psu-pty' });
    expect(String(b.title)).toContain('FIND ME');
    expect(String(b.title)).toContain('come find me');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('psu-pty fails + no tty on record -> landed:false with a loud reason', async () => {
    getPresence.mockResolvedValue({ ownerId: 'su-a', tty: null });
    recolorViaPty.mockResolvedValue(false);
    const b = await run({ ownerId: 'su-a' });
    expect(b).toMatchObject({ ok: false, landed: false, via: null });
    expect(String(b.reason)).toMatch(/no tty recorded/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('psu-pty fails + tty recorded but claimed by a DIFFERENT owner -> refuses the write', async () => {
    getPresence.mockResolvedValue({ ownerId: 'su-a', tty: '/dev/pts/5' });
    recolorViaPty.mockResolvedValue(false);
    readFile.mockResolvedValue('su-someone-else\n');
    const b = await run({ ownerId: 'su-a' });
    expect(b).toMatchObject({ ok: false, landed: false, via: null });
    expect(String(b.reason)).toMatch(/currently claimed by a different session/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('psu-pty fails + tty recorded + NO claim file on record -> fails OPEN and writes', async () => {
    getPresence.mockResolvedValue({ ownerId: 'su-a', tty: '/dev/pts/5' });
    recolorViaPty.mockResolvedValue(false);
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    writeFile.mockResolvedValue(undefined);
    const b = await run({ ownerId: 'su-a' });
    expect(b).toMatchObject({ ok: true, landed: true, via: 'tty' });
    expect(writeFile).toHaveBeenCalledWith('/dev/pts/5', expect.stringContaining('FIND ME'));
  });

  it('psu-pty fails + tty recorded + claimed by the SAME owner -> writes the OSC title', async () => {
    getPresence.mockResolvedValue({ ownerId: 'su-a', tty: '/dev/pts/5' });
    recolorViaPty.mockResolvedValue(false);
    readFile.mockResolvedValue('su-a\n');
    writeFile.mockResolvedValue(undefined);
    const b = await run({ ownerId: 'su-a' });
    expect(b).toMatchObject({ ok: true, landed: true, via: 'tty' });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('the direct write throwing -> landed:false with a loud reason (never throws to the caller)', async () => {
    getPresence.mockResolvedValue({ ownerId: 'su-a', tty: '/dev/pts/5' });
    recolorViaPty.mockResolvedValue(false);
    readFile.mockResolvedValue('su-a\n');
    writeFile.mockRejectedValue(new Error('EACCES: permission denied'));
    const b = await run({ ownerId: 'su-a' });
    expect(b).toMatchObject({ ok: false, landed: false, via: null });
    expect(String(b.reason)).toMatch(/write to \/dev\/pts\/5 failed/);
    expect(String(b.reason)).toMatch(/EACCES/);
  });
});
