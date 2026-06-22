/**
 * Coverage for agent-bin-detect.detectBinaries — `which`-based absolute-path
 * resolution for claude/codex/omp/pi. spawnSync is mocked; asserts found→trimmed-path,
 * non-zero-exit→null, and exit-0-but-empty-stdout→null.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnSync = vi.fn();
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...a: unknown[]) => spawnSync(...(a as [])) };
});

import { detectBinaries } from './agent-bin-detect';

afterEach(() => spawnSync.mockReset());

/** Route `which <bin>` by the bin name. */
function routeWhich(found: Record<string, string>) {
  spawnSync.mockImplementation((_cmd: string, args: string[]) => {
    const bin = args[0];
    const path = found[bin];
    return path ? { status: 0, stdout: `${path}\n` } : { status: 1, stdout: '' };
  });
}

describe('detectBinaries', () => {
  it('returns trimmed absolute paths for found binaries', () => {
    routeWhich({ claude: '/usr/local/bin/claude', codex: '/usr/bin/codex', omp: '/opt/omp' });
    expect(detectBinaries()).toEqual({
      claude: '/usr/local/bin/claude',
      codex: '/usr/bin/codex',
      omp: '/opt/omp',
      pi: null,
    });
  });

  it('returns all null when none are on PATH', () => {
    routeWhich({});
    expect(detectBinaries()).toEqual({ claude: null, codex: null, omp: null, pi: null });
  });

  it('treats exit 0 with empty stdout as not found', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '   ' });
    expect(detectBinaries()).toEqual({ claude: null, codex: null, omp: null, pi: null });
  });
});
