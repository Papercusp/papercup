import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../../../scripts/tauri-surface-verify-dao-launch.sh');
const repo = resolve(import.meta.dirname, '../../../..');

// Exercise the maintained real-mode bootstrap and vh.sh. Stop at the first
// bridge command so this fixture never starts or interacts with a desktop.
function bootstrap(frozen: boolean, originalRoot?: string) {
  const dir = mkdtempSync(resolve(tmpdir(), 'dao-surface-bootstrap-'));
  try {
    const bin = resolve(dir, 'bin');
    const copied = resolve(dir, 'work/assertion-script.sh');
    const calls = resolve(dir, 'bridge-calls');
    const alive = resolve(dir, 'alive.sh');
    mkdirSync(bin);
    mkdirSync(resolve(dir, 'work'));
    writeFileSync(copied, readFileSync(script));
    writeFileSync(alive, '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(resolve(bin, 'tauri-agent-tools'),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DAO_BOOTSTRAP_CALLS"\nexit 73\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      VERIFY_TAURI_PID: 'bootstrap-fixture', VERIFY_TAURI_POLL: alive,
      VERIFY_TAURI_LIVENESS_CHECK: alive, VERIFY_TAURI_ISOLATED_DB: '1',
      VERIFY_TAURI_SPA_DIST: '', TAURI_SURFACE_VERIFY_DAO_LAUNCH_OUT: resolve(dir, 'out'),
      DAO_BOOTSTRAP_CALLS: calls, VH_DISABLE: '0', VH_FAIL_OPEN: '0' };
    delete (env as NodeJS.ProcessEnv).VERIFY_TAURI_ORIGINAL_REPO_DIR;
    delete (env as NodeJS.ProcessEnv).VH_TSX;
    if (originalRoot !== undefined) (env as NodeJS.ProcessEnv).VERIFY_TAURI_ORIGINAL_REPO_DIR = originalRoot;
    const result = spawnSync('bash', [frozen ? copied : script], {
      cwd: dir, env, encoding: 'utf8', timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Feed every real generated poll through the maintained helper. The bridge
// fixture records its arguments; this checks the CLI contract, not DOM truth.
function pollContract(source = readFileSync(script, 'utf8')) {
  const dir = mkdtempSync(resolve(tmpdir(), 'dao-poll-contract-'));
  try {
    const wrapper = readFileSync(resolve(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
    const helper = wrapper.match(/cat > "\$POLL" <<'POLL_SCRIPT'\n([\s\S]*?)\nPOLL_SCRIPT/)?.[1];
    if (!helper) throw new Error('Maintained DOM poll helper not found');
    const helperPath = resolve(dir, 'poll.sh');
    const driver = resolve(dir, 'contract.sh');
    const tool = resolve(dir, 'bridge.sh');
    const calls = resolve(dir, 'calls');
    writeFileSync(helperPath, helper);
    writeFileSync(driver, '#!/usr/bin/env bash\nVERIFY_TAURI_LIVENESS_CHECK= bash "$DAO_REAL_POLL" "$@"\n', { mode: 0o755 });
    writeFileSync(tool, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$DAO_POLL_ARGS_LOG"\nexit 0\n', { mode: 0o755 });
    const begin = 'dao_syntax_poll() {\n';
    if (!source.includes(begin)) throw new Error('Syntax poll entry not found');
    const path = resolve(dir, 'assertions.sh');
    writeFileSync(path, source.replace(begin, `${begin}  "$DAO_POLL_CONTRACT" "$@" || return "$?"\n`));
    const result = spawnSync('bash', [path, '--check-syntax'], {
      env: { ...process.env, DAO_POLL_CONTRACT: driver, DAO_REAL_POLL: helperPath,
        DAO_POLL_ARGS_LOG: calls, VERIFY_TAURI_AGENT_TOOLS_BIN: tool,
        VERIFY_TAURI_PID: 'poll-contract-fixture',
        VERIFY_TAURI_DOM_TIMEOUT: '0', VERIFY_TAURI_DOM_POLL_INTERVAL: '0' },
      encoding: 'utf8', timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function run(path: string, syntax = true) {
  const env = { ...process.env };
  delete env.VERIFY_TAURI_PID;
  delete env.VERIFY_TAURI_POLL;
  delete env.VERIFY_TAURI_LIVENESS_CHECK;
  delete env.VERIFY_TAURI_ISOLATED_DB;
  try {
    return execFileSync('bash', [path, ...(syntax ? ['--check-syntax'] : [])], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status, stderr: String(failure.stderr ?? '') };
  }
}

describe('maintained DAO native assertion syntax preflight', () => {
  it('preflights every generated poll with the real helper and fuses both legal close guards', () => {
    const result = pollContract();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('DAO_SURFACE_SYNTAX_ONLY');
    expect(result.stdout).not.toContain('P009_TAURI_SURFACE_VERIFY_OK');
    const closure = '(document.querySelectorAll(\'.dao-section-overview\').length >= 1) && (!document.querySelector(".dao-modal"))';
    expect(result.calls.split(closure).length - 1).toBe(2);
  }, 25_000);

  it('rejects a reverted legal close guard before any desktop boot', () => {
    const source = readFileSync(script, 'utf8');
    const guarded = `--require '.dao-section-overview' --eval '!document.querySelector(".dao-modal")'`;
    if (!source.includes(guarded)) throw new Error('Legal close guard not found');
    const result = pollContract(source.replace(guarded, guarded.replace('--require', '--selector')));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('UNGUARDED NEGATIVE DOM assertion');
    expect(result.stdout).not.toContain('DAO_SURFACE_SYNTAX_ONLY');
  }, 25_000);

  it('bootstraps the real instrumentation from a frozen copy using the exported original repository', () => {
    const result = bootstrap(true, repo);
    expect(result.status, result.stderr).toBe(73);
    expect(result.stdout).toContain('VH_BEGIN phase=native-assertions');
    expect(result.calls).toContain('eval window.__TSR_ROUTER__.navigate');
    expect(result.stdout).not.toContain('P009_TAURI_SURFACE_VERIFY_OK');
  }, 35_000);

  it('retains the direct-script repository fallback when no original root is exported', () => {
    const result = bootstrap(false);
    expect(result.status, result.stderr).toBe(73);
    expect(result.stdout).toContain('VH_BEGIN phase=native-assertions');
    expect(result.calls).toContain('eval window.__TSR_ROUTER__.navigate');
  }, 35_000);

  it('refuses an unusable exported repository before any bridge interaction', () => {
    const invalidRoot = resolve(repo, 'nonexistent-dao-bootstrap-control');
    const result = bootstrap(true, invalidRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${invalidRoot}/libs/generic/verification-harness/bin/vh.sh`);
    expect(result.calls).toBe('');
    expect(result.stdout).not.toContain('VH_BEGIN phase=native-assertions');
  }, 35_000);

  it('parses every real eval/poll expression for both legal routes and themes without a native runtime', () => {
    const result = run(script);
    expect(result).toEqual(expect.stringContaining('DAO_SURFACE_SYNTAX_ONLY'));
    expect(result).not.toEqual(expect.stringContaining('P009_TAURI_SURFACE_VERIFY_OK'));
  });

  it('catches the escaped-quote defect before a desktop boot', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'dao-surface-syntax-'));
    try {
      const path = resolve(dir, 'broken.sh');
      const source = readFileSync(script, 'utf8');
      const original = 'native eval \'window.__TSR_ROUTER__.navigate';
      if (!source.includes(original)) throw new Error('Navigation expression not found');
      writeFileSync(path, source.replace(original, 'native eval \'const broken=\\"quoted\\";window.__TSR_ROUTER__.navigate'));
      expect(run(path)).toMatchObject({ status: 1, stderr: expect.stringContaining('SyntaxError') });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('continues to refuse a real run without its owned runtime and isolated database', () => {
    expect(run(script, false)).toMatchObject({ status: 1, stderr: expect.stringContaining('VERIFY_TAURI_PID') });
  });
});
