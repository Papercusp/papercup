/**
 * WI-10005581 recurrence guard — the bench's GitNexus arm must spawn `gitnexus analyze` under the SAME
 * environment production's `system:gitnexus-reindex` uses, never the vendor's bare defaults.
 *
 * The defect this pins: the arm spawned the `.bin` shim with only `HOME`, so the installed 1.6.9 analyzer
 * ran on a 16 GiB LadybugDB max_db_size + its manual WAL checkpoint (which production switches off on
 * Linux). An incremental refresh after the edit fixture then hit
 * "Buffer manager exception: Maximum database size of 17179869184 bytes has been reached" inside that
 * checkpoint and died with SIGSEGV (exit 139) — a configuration the product never runs, graded as if it
 * were the engine. Nothing here spawns a real engine: `ArmDeps.exec` is a spy.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GITNEXUS_ANALYZE_STACK_KB,
  GITNEXUS_LBUG_BUFFER_POOL_BYTES,
  GITNEXUS_LBUG_MAX_DB_BYTES,
  GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX,
} from '../harness/routines/gitnexus-reindex-action';
import {
  createGitnexusArm,
  gitnexusAnalyzeInvocation,
  type ArmDeps,
  type ExecOptions,
  type ExecResult,
} from './engine-comparison-arms';

/** GitNexus's own default ceiling (lbug-config.js `LBUG_MAX_DB_SIZE`): 16 GiB. */
const VENDOR_DEFAULT_MAX_DB_BYTES = 17_179_869_184;

describe('gitnexus bench arm spawns analyze under the production analyze environment', () => {
  let root: string;
  let shim: string;
  let cli: string;
  const home = '/scratch/home';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gnx-arm-test-'));
    const dist = join(root, 'node_modules', 'gitnexus', 'dist', 'cli');
    mkdirSync(dist, { recursive: true });
    cli = join(dist, 'index.js');
    writeFileSync(cli, '// fake cli entry\n');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    shim = join(root, 'node_modules', '.bin', 'gitnexus');
    // npm installs the bin as a relative symlink to the CLI entry; resolve it the same way.
    symlinkSync('../gitnexus/dist/cli/index.js', shim);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('runs node on the RESOLVED cli entry with --stack-size as argv (the re-exec the NODE_OPTIONS pin skips)', () => {
    const inv = gitnexusAnalyzeInvocation({ bin: shim, home }, ['analyze', '--skip-agents-md', '.'], { PATH: '/usr/bin' });
    expect(inv.cmd).toBe(process.execPath);
    expect(inv.args).toEqual([`--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`, realpathSync(cli), 'analyze', '--skip-agents-md', '.']);
    expect(inv.args[1]).not.toBe(shim);
  });

  it('pins the LadybugDB ceiling ABOVE the vendor default, plus the buffer pool and heap', () => {
    const { env } = gitnexusAnalyzeInvocation({ bin: shim, home }, ['analyze', '.'], { PATH: '/usr/bin' });
    expect(Number(env.GITNEXUS_LBUG_MAX_DB_SIZE)).toBe(GITNEXUS_LBUG_MAX_DB_BYTES);
    expect(Number(env.GITNEXUS_LBUG_MAX_DB_SIZE)).toBeGreaterThan(VENDOR_DEFAULT_MAX_DB_BYTES);
    expect(Number(env.GITNEXUS_LBUG_BUFFER_POOL_SIZE)).toBe(GITNEXUS_LBUG_BUFFER_POOL_BYTES);
    expect(env.NODE_OPTIONS).toMatch(/--max-old-space-size=\d+/);
  });

  it.runIf(process.platform === 'linux')('switches gitnexus manual WAL checkpoint OFF on Linux (the path that threw)', () => {
    const { env } = gitnexusAnalyzeInvocation({ bin: shim, home }, ['analyze', '.'], { PATH: '/usr/bin' });
    expect(env.GITNEXUS_WAL_MANUAL_CHECKPOINT).toBe(GITNEXUS_WAL_MANUAL_CHECKPOINT_LINUX);
    expect(env.GITNEXUS_WAL_MANUAL_CHECKPOINT).toBe('0');
  });

  it('keeps the arm-scoped HOME (never the serving registry) and lets an operator-set pin win', () => {
    const { env } = gitnexusAnalyzeInvocation({ bin: shim, home }, ['analyze', '.'], {
      PATH: '/usr/bin',
      HOME: join(root, 'serving-home'),
      GITNEXUS_LBUG_MAX_DB_SIZE: '999',
    });
    expect(env.HOME).toBe(home);
    expect(env.GITNEXUS_LBUG_MAX_DB_SIZE).toBe('999');
  });

  describe('createGitnexusArm wiring — index AND refresh both go through it', () => {
    const ok: ExecResult = { code: 0, stdout: '', stderr: '', wallMs: 1, peakRssKb: 1 };
    const calls: { cmd: string; args: readonly string[]; opts: ExecOptions }[] = [];
    const exec: NonNullable<ArmDeps['exec']> = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return ok;
    };
    const build = () =>
      createGitnexusArm(
        { id: 'gitnexus-installed', version: '1.6.9', bin: shim, treeRoot: '/scratch/tree', home },
        { loadAvg1: () => 0, exec },
        (async () => ({ sites: [] })) as never,
        () => null,
      );

    it('cold index (`--force`) and incremental refresh both spawn node + pinned env, not the bare shim', async () => {
      calls.length = 0;
      const arm = build();
      await arm.index();
      await arm.refresh();
      expect(calls).toHaveLength(2);
      for (const c of calls) {
        expect(c.cmd).toBe(process.execPath);
        expect(c.args[0]).toBe(`--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`);
        expect(c.opts.cwd).toBe('/scratch/tree');
        expect(c.opts.env?.HOME).toBe(home);
        expect(Number(c.opts.env?.GITNEXUS_LBUG_MAX_DB_SIZE)).toBeGreaterThan(VENDOR_DEFAULT_MAX_DB_BYTES);
        expect(c.args).toContain('--skip-agents-md');
      }
      expect(calls[0]!.args).toContain('--force');
      expect(calls[1]!.args).not.toContain('--force');
    });
  });
});
