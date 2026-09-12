/**
 * Regression guard for EI-22472379185031927.
 *
 * `ci-provision-pg.mjs --help` is argument discovery, not provisioning. The
 * help branch must run before the database-only imports or Postgres client
 * construction, so CI diagnostics cannot touch credentials or a live database.
 */
import { describe, expect, it, vi } from 'vitest';

const postgres = vi.hoisted(() => vi.fn());
vi.mock('postgres', () => ({ default: postgres }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs CLI exports are exercised directly.
import { main, parseArgs, USAGE } from '../../../scripts/ci-provision-pg.mjs';

describe('ci-provision-pg CLI help (EI-22472379185031927)', () => {
  it('parses both help spellings without side effects', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
    expect(parseArgs([])).toEqual({ help: false });
  });

  it('prints usage and constructs no Postgres client for --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(main(['--help'])).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(USAGE);
      expect(postgres).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
