import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { IGNORE_PATTERNS } from './policy';

/**
 * Integration test: prove that snapshotting workspaceRoot does NOT
 * recursively include the kopia repo (which lives inside workspaceRoot
 * at backups/kopia-repo). Two regressions have been caused by the
 * `backups` exclusion missing from IGNORE_PATTERNS — see the comment
 * on IGNORE_PATTERNS in policy.ts. The companion assertion proves
 * db-dumps/ (the PG dump) IS captured — point-in-time restore needs it.
 *
 * We exercise the real `kopia` binary against a scratch dir, mirroring
 * the production setup (repo inside workspaceRoot, policy applied via
 * `policy set --global --add-ignore`). No PG required.
 */

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';
const PASSWORD = 'self-exclusion-test-password';

// Module-load probe: this suite drives the REAL kopia binary, which CI
// runners don't ship (WI-123: `spawn kopia ENOENT`). Genuinely skip there;
// run wherever kopia is installed (dev boxes, the local gate).
const kopiaAvailable = (() => {
  try {
    return spawnSync(KOPIA_BIN, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

function kopia(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(KOPIA_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; const err: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => resolve({
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      code: code ?? -1,
    }));
  });
}

async function kopiaOk(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const r = await kopia(args, env);
  if (r.code !== 0) throw new Error(`kopia ${args.join(' ')} exited ${r.code}: ${r.stderr}`);
  return r.stdout;
}

describe.skipIf(!kopiaAvailable)('backup self-exclusion', () => {
  let workspaceRoot: string;
  let repoPath: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'backup-self-excl-'));
    repoPath = join(workspaceRoot, 'backups', 'kopia-repo');
    await mkdir(repoPath, { recursive: true });

    env = {
      ...process.env,
      KOPIA_PASSWORD: PASSWORD,
      KOPIA_CONFIG_PATH: join(workspaceRoot, 'backups', 'repository.config'),
      KOPIA_LOG_DIR: join(workspaceRoot, 'backups', 'logs'),
      KOPIA_CACHE_DIRECTORY: join(workspaceRoot, 'backups', 'cache'),
    };

    // Real content to snapshot.
    await writeFile(join(workspaceRoot, 'hello.txt'), 'hello world\n');
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(join(workspaceRoot, 'src', 'a.ts'), 'export const x = 1;\n');
    // db-dumps/ holds the pre-snapshot PG dump — it MUST be captured by
    // the snapshot; point-in-time DB restore depends on it.
    await mkdir(join(workspaceRoot, 'db-dumps'), { recursive: true });
    await writeFile(join(workspaceRoot, 'db-dumps', 'pg-embedded.sql.gz'), 'fake dump\n');

    await kopiaOk(['repository', 'create', 'filesystem', '--path', repoPath], env);
    await kopiaOk(
      ['policy', 'set', '--global', ...IGNORE_PATTERNS.map((p) => `--add-ignore=${p}`)],
      env,
    );
  }, 60_000);

  afterAll(async () => {
    try { await kopia(['repository', 'disconnect'], env); } catch { /* best effort */ }
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('does not include backups/ in the snapshot manifest', async () => {
    await kopiaOk(['snapshot', 'create', workspaceRoot, '--json'], env);
    const listRaw = await kopiaOk(['snapshot', 'list', workspaceRoot, '--json'], env);
    const snapshots = JSON.parse(listRaw) as Array<{ rootEntry?: { summ?: { size?: number } } }>;
    expect(snapshots.length).toBeGreaterThan(0);

    // Browse the snapshot root and confirm 'backups' is not a child entry.
    const last = snapshots[snapshots.length - 1] as { id: string };
    const lsRaw = await kopiaOk(['ls', last.id], env);
    const names = lsRaw.trim().split('\n').filter(Boolean).map((line) => {
      // kopia ls output ends with the entry name; directories end in '/'.
      const name = line.split(/\s+/).pop() ?? '';
      return name.replace(/\/$/, '');
    });
    expect(names).toContain('hello.txt');
    expect(names).toContain('src');
    // db-dumps/ IS versioned — the PG dump must be restorable.
    expect(names).toContain('db-dumps');
    // backups/ (the kopia repo itself) is NOT — that's the recursion guard.
    expect(names).not.toContain('backups');
  }, 60_000);

  it('does not balloon when snapshotted repeatedly (recursive-inclusion regression)', async () => {
    // Plant a large blob inside backups/ to simulate the kopia store
    // itself. If `backups` weren't excluded, the second snapshot would
    // pull this in and bytes-added would equal ~its size.
    const fatBlobPath = join(workspaceRoot, 'backups', 'fat.bin');
    const TEN_MB = 10 * 1024 * 1024;
    await writeFile(fatBlobPath, Buffer.alloc(TEN_MB, 0x42));
    expect((await stat(fatBlobPath)).size).toBe(TEN_MB);

    // Touch a tiny real file so there's a legit delta to snapshot.
    await writeFile(join(workspaceRoot, 'hello.txt'), 'hello world v2\n');

    const json = await kopiaOk(['snapshot', 'create', workspaceRoot, '--json'], env);
    // Kopia emits ndjson-ish output; grab the final manifest line.
    const lines = json.trim().split('\n').filter(Boolean);
    const manifest = JSON.parse(lines[lines.length - 1]!) as {
      stats?: { totalSize?: number; addedSize?: number };
    };
    const totalSize = manifest.stats?.totalSize ?? 0;

    // Real content is ~40 bytes. If backups/fat.bin (10MB) sneaked in,
    // totalSize would be >= 10MB. Fail well below that.
    expect(totalSize).toBeLessThan(1 * 1024 * 1024);
  }, 60_000);
});
