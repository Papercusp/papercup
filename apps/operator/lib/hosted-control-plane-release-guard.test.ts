import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const sourceRoot = resolve(__dirname, '../../..');
const installerPath = 'apps/operator/scripts/systemd/deploy-hosted-control-plane.sh';
const templatePath = 'apps/operator/scripts/systemd/papercusp-hosted-control-plane.service.in';
const freshnessPath = 'apps/operator/bin/bundle-host-freshness.mjs';
let temp: string;
let repo: string;
let green: string;
let env: NodeJS.ProcessEnv;

function git(...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function install(args: string[] = ['--install-only'], sha = green) {
  return spawnSync('bash', [join(repo, installerPath), ...args, '--production-release', sha], {
    encoding: 'utf8', env, timeout: 15_000,
  });
}

function stamp() {
  execFileSync(process.execPath, [join(repo, freshnessPath), 'stamp',
    '--repo-root', repo, '--entry', join(repo, 'apps/operator/bin/serve.ts'),
    '--outfile', join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'),
    '--manifest', join(repo, 'apps/operator/dist-hosted-control-plane/.bundle-fresh.json'),
  ], { stdio: 'pipe' });
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'hosted-release-'));
  repo = join(temp, 'release');
  mkdirSync(repo);
  for (const path of [installerPath, templatePath, freshnessPath]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    copyFileSync(join(sourceRoot, path), join(repo, path));
  }
  writeFileSync(join(repo, '.gitignore'), 'apps/operator/dist-hosted-control-plane/\n');
  writeFileSync(join(repo, 'apps/operator/bin/serve.ts'), '// pinned entry\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '--no-verify', '-qm', 'green fixture');
  green = git('rev-parse', 'HEAD');
  git('checkout', '--detach', '-q', green);
  mkdirSync(join(repo, 'apps/operator/dist-hosted-control-plane'));
  writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'), '// built bundle\n');
  stamp();
  const systemctl = join(temp, 'systemctl');
  writeFileSync(systemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
  env = { ...process.env,
    PAPERCUSP_DEPLOYMENT_ENVIRONMENT: 'production',
    PAPERCUSP_HOSTED_CP_REPO_ROOT: repo,
    PAPERCUSP_HOSTED_CP_TEMPLATE: join(repo, templatePath),
    PAPERCUSP_HOSTED_CP_NODE: process.execPath,
    PAPERCUSP_HOSTED_CP_ENV_FILE: join(temp, 'production.env'),
    PAPERCUSP_HOSTED_CP_UNIT_DIR: join(temp, 'units'),
    PAPERCUSP_HOSTED_CP_UNIT: 'hosted-production.service',
    PAPERCUSP_HOSTED_CP_SYSTEMCTL: systemctl,
    PAPERCUSP_HOSTED_CP_SYSTEMD_ANALYZE: '/bin/true',
    TEST_SYSTEMCTL_LOG: join(temp, 'systemctl.log'),
  };
});

afterEach(() => rmSync(temp, { recursive: true, force: true }));

function expectRefused(reason: RegExp, sha = green) {
  const result = install(['--install-only'], sha);
  expect(result.status, result.stderr).not.toBe(0);
  expect(result.stderr).toMatch(reason);
  expect(existsSync(join(temp, 'units'))).toBe(false);
  expect(existsSync(join(temp, 'systemctl.log'))).toBe(false);
}

describe('SPEC-P-007 production green-main deploy guard', () => {
  it('installs a proved green bundle and rechecks it before each production start', () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    const unit = readFileSync(join(temp, 'units/hosted-production.service'), 'utf8');
    expect(unit).toContain(`--check-release --production-release ${green}`);
    expect(unit).toContain('Environment=PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production');
    expect(unit).not.toContain('PAPERCUSP_BUNDLE_ALLOW_STALE_START=1');
    expect(unit).not.toContain('bundle-host.sh');
    const boot = unit.split('\n').find(line => line.startsWith('ExecStart='))!;
    expect(boot).toContain(`/usr/bin/bash -ec 'set -a; . "${temp}/production.env"`);
    expect(boot).not.toContain('.env.local');
    expect(boot).not.toContain('HARNESS_ADMIN_DATABASE_URL=');
    expect(boot).toContain('export PAPERCUSP_DEPLOYMENT_ENVIRONMENT=production');
    expect(boot).toContain('exec node dist-hosted-control-plane/serve.mjs');
    expect(readFileSync(join(temp, 'systemctl.log'), 'utf8')).toBe('--user daemon-reload\n');
    // Exercise the actual pre-start command, rather than merely inspecting its text.
    const command = unit.split('\n').find(line => line.startsWith('ExecStartPre='))!.slice('ExecStartPre='.length);
    expect(spawnSync('bash', ['-c', command], { env, encoding: 'utf8' }).status).toBe(0);
    writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'), '// replaced after install\n');
    const tampered = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('freshness proof failed');
  });

  it('rejects a staging-only/red commit before any installation side effect', () => {
    git('checkout', '-qb', 'staging');
    writeFileSync(join(repo, 'red.txt'), 'red\n');
    git('add', 'red.txt');
    git('commit', '--no-verify', '-qm', 'unpromoted fixture');
    const red = git('rev-parse', 'HEAD');
    git('checkout', '--detach', '-q', red);
    stamp();
    expectRefused(/not the green main pin/, red);
  });

  it('boots with injected production configuration even when local env tries to disable the policy', () => {
    const capture = join(temp, 'boot.json');
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/serve.mjs'),
      'import {writeFileSync} from "node:fs"; writeFileSync(process.env.TEST_BOOT_CAPTURE, JSON.stringify({environment:process.env.PAPERCUSP_DEPLOYMENT_ENVIRONMENT,admin:process.env.HARNESS_ADMIN_DATABASE_URL,app:process.env.HARNESS_DATABASE_URL,profile:process.env.PAPERCUSP_DISTRIBUTION_PROFILE}));\n');
    stamp();
    writeFileSync(join(repo, 'apps/operator/.env.local'),
      'PAPERCUSP_DEPLOYMENT_ENVIRONMENT=development\nHARNESS_ADMIN_DATABASE_URL=postgres://dev@localhost/dev\n');
    writeFileSync(join(temp, 'production.env'),
      'PAPERCUSP_DEPLOYMENT_ENVIRONMENT=development\nHARNESS_ADMIN_DATABASE_URL=postgres://admin:injected-secret@10.60.0.2/papercusp_hosted\nHARNESS_DATABASE_URL=postgres://app:injected-secret@10.60.0.2/papercusp_hosted\n');
    const result = install(['--render-only']);
    expect(result.status, result.stderr).toBe(0);
    const command = result.stdout.split('\n').find(line => line.startsWith('ExecStart='))!.slice('ExecStart='.length);
    const boot = spawnSync('bash', ['-c', command], {
      cwd: join(repo, 'apps/operator'),
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, TEST_BOOT_CAPTURE: capture },
      encoding: 'utf8',
    });
    expect(boot.status, boot.stderr).toBe(0);
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({
      environment: 'production',
      admin: 'postgres://admin:injected-secret@10.60.0.2/papercusp_hosted',
      app: 'postgres://app:injected-secret@10.60.0.2/papercusp_hosted',
      profile: 'hosted-control-plane',
    });
    rmSync(join(temp, 'production.env'));
    const missing = spawnSync('bash', ['-c', command], {
      cwd: join(repo, 'apps/operator'), env: { ...env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('production.env');
  });

  it('rejects a valid green pin when the checkout is at another commit', () => {
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    git('add', 'other.txt');
    git('commit', '--no-verify', '-qm', 'other fixture');
    expectRefused(/checkout does not match/);
  });

  it('rejects the mutable main working tree even when its SHA is green', () => {
    git('checkout', '-q', 'main');
    expectRefused(/detached release checkout/);
  });

  it('rejects an absent green main authority', () => {
    git('branch', '-D', 'main');
    expectRefused(/green main pin is unavailable/);
  });

  it('rejects uncommitted tracked source changes', () => {
    writeFileSync(join(repo, 'apps/operator/bin/serve.ts'), '// changed source\n');
    expectRefused(/freshness proof failed/);
  });

  it('rejects a missing bundle proof', () => {
    rmSync(join(repo, 'apps/operator/dist-hosted-control-plane/.bundle-fresh.json'));
    expectRefused(/freshness proof failed/);
  });

  it('rejects a stale bundle even when an older freshness proof remains', () => {
    writeFileSync(join(repo, 'apps/operator/dist-hosted-control-plane/.bundle-stale.json'), '{}');
    expectRefused(/bundle is marked stale/);
  });

  it('requires an explicit full SHA and refuses branch names', () => {
    expectRefused(/full commit SHA/, 'main');
    const result = spawnSync('bash', [join(repo, installerPath), '--install-only'], { env, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('requires --production-release');
    expect(existsSync(join(temp, 'units'))).toBe(false);
  });
});
