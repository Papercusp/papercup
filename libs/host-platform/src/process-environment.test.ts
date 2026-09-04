import { describe, expect, it, vi } from 'vitest';

import {
  inspectProcessEnvironment,
  parseNulSeparatedEnvironment,
  parsePsEwwEnvironment,
} from './process-environment';

describe('process environment parsing', () => {
  it('parses exact NUL-delimited entries without corrupting spaces or embedded equals', () => {
    expect(
      parseNulSeparatedEnvironment('A=hello world\0EMPTY=\0TOKEN=a=b=c\0NO_EQUALS\0A=shadowed\0'),
    ).toEqual({ A: 'hello world', EMPTY: '', TOKEN: 'a=b=c' });
  });

  it('uses assignment boundaries for ps output instead of splitting values on spaces', () => {
    const raw =
      '/usr/bin/node worker.js MODE=argv MODE=real TEST_VAR=hello world with spaces EMPTY= TOKEN=a=b=c';
    expect(parsePsEwwEnvironment(raw)).toEqual({
      MODE: 'real',
      TEST_VAR: 'hello world with spaces',
      EMPTY: '',
      TOKEN: 'a=b=c',
    });
  });
});

describe('inspectProcessEnvironment', () => {
  it('prefers an exact owning-spawn snapshot over host inspection', async () => {
    const readProcEnvironment = vi.fn(async () => 'WRONG=host\0');
    const result = await inspectProcessEnvironment(42, {
      platform: 'linux',
      readSpawnSnapshot: async () => JSON.stringify({ TEST_VAR: 'hello world', TOKEN: 'a=b=c' }),
      readProcEnvironment,
    });
    expect(result).toEqual({
      ok: true,
      environment: { TEST_VAR: 'hello world', TOKEN: 'a=b=c' },
      source: 'spawn-snapshot',
      fidelity: 'exact',
    });
    expect(readProcEnvironment).not.toHaveBeenCalled();
  });

  it('reads Linux procfs as exact NUL-delimited data', async () => {
    const readProcEnvironment = vi.fn(async () => 'TEST_VAR=hello world\0');
    const result = await inspectProcessEnvironment(77, { platform: 'linux', readProcEnvironment });
    expect(readProcEnvironment).toHaveBeenCalledWith(77);
    expect(result).toEqual({
      ok: true,
      environment: { TEST_VAR: 'hello world' },
      source: 'procfs',
      fidelity: 'exact',
    });
  });

  it('labels macOS ps parsing best-effort rather than exact', async () => {
    const readPsCommand = vi.fn(async () => '/bin/app TEST_VAR=hello world NEXT=value');
    const result = await inspectProcessEnvironment(88, { platform: 'darwin', readPsCommand });
    expect(readPsCommand).toHaveBeenCalledWith(88);
    expect(result).toEqual({
      ok: true,
      environment: { TEST_VAR: 'hello world', NEXT: 'value' },
      source: 'ps',
      fidelity: 'best-effort',
    });
  });

  it('falls back when a spawn snapshot is stale or malformed', async () => {
    const result = await inspectProcessEnvironment(99, {
      platform: 'linux',
      readSpawnSnapshot: async () => '{not-json',
      readProcEnvironment: async () => 'FALLBACK=used\0',
    });
    expect(result).toEqual({
      ok: true,
      environment: { FALLBACK: 'used' },
      source: 'procfs',
      fidelity: 'exact',
    });
  });

  it('fails soft for invalid, unreadable, and unsupported targets', async () => {
    await expect(inspectProcessEnvironment(0)).resolves.toMatchObject({ ok: false, reason: 'invalid-pid' });
    await expect(
      inspectProcessEnvironment(101, {
        platform: 'linux',
        readProcEnvironment: async () => {
          throw new Error('gone');
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'unreadable', detail: expect.stringContaining('gone') });
    await expect(inspectProcessEnvironment(102, { platform: 'win32' })).resolves.toMatchObject({
      ok: false,
      reason: 'unsupported-platform',
    });
  });
});
