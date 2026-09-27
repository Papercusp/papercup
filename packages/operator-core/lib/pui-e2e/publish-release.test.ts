import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');
// Overridable so scripts/mutation-probe.sh can point the suite at a mutated COPY of the
// publisher (copy-out tier) instead of mutating the shared tree.
const PUBLISH = process.env.PUI_PUBLISH_SCRIPT || join(REPO_ROOT, 'apps/tui/scripts/publish-release.sh');
const roots: string[] = [];

// The publisher resolves its host as PAPERCUSP_UPDATE_BASE_URL ?? PAPERCUSP_RELEASE_HOST AFTER
// sourcing the release-host env file, so an AMBIENT value wins over the fixture file. testing:run
// spawns vitest from the operator process, whose environment carries the real release host, and
// the suite then asserted production keys against fixture expectations (4 reds, run 5e50b3df,
// 2026-09-27). Every spawn therefore starts from an env with the release-host, storage and
// Portal-link variables removed; each test supplies exactly the ones it means to.
const INHERITED_RELEASE_ENV = /^(PAPERCUSP_UPDATE_BASE_URL|PAPERCUSP_RELEASE_HOST|PUI_.*|R2_.*|AWS_.*|NEXT_PUBLIC_PORTAL_.*)$/;
function hermeticEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!INHERITED_RELEASE_ENV.test(key)) env[key] = value;
  }
  return { ...env, ...overrides };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function candidate() {
  const root = mkdtempSync(join(tmpdir(), 'pui-publish-test-'));
  roots.push(root);
  const unitName = 'pui-0.1.0-linux-x86_64';
  const unit = join(root, unitName);
  mkdirSync(unit);
  const sourceSha = 'a'.repeat(40);
  writeFileSync(join(unit, 'PROVENANCE.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'pui',
    version: '0.1.0',
    target: 'linux-x86_64',
    source: { commit: sourceSha },
  }));
  writeFileSync(join(unit, 'README.md'), 'fixture\n');
  const archive = join(root, `${unitName}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', root, unitName]);
  const digest = sha256(archive);
  writeFileSync(join(root, 'SHA256SUMS'), `${digest}  ${unitName}.tar.gz\n`);
  const acceptance = `${archive}.acceptance.json`;
  writeFileSync(acceptance, JSON.stringify({
    schemaVersion: 1,
    ok: true,
    candidate: { archiveSha256: digest, sourceSha, advertise: [{ platform: 'Linux x86_64', backend: 'Claude' }] },
    refusals: [],
    runner: {
      stockMachines: [{ image: 'ubuntu:24.04', status: 0 }, { image: 'debian:stable-slim', status: 0 }],
      cloudDeviceStart: { ok: true, status: 200 },
      legs: [{ engine: 'scripted', status: 0 }, { engine: 'claude', status: 0 }],
      suiteProvenance: [{ candidateBlob: 'b'.repeat(40), runBlob: 'b'.repeat(40) }],
    },
  }));
  const hostEnv = join(root, 'release-host.env');
  writeFileSync(hostEnv, 'PAPERCUSP_RELEASE_HOST=https://pub.example.test/unguessable-prefix\n');
  return { root, archive, acceptance, hostEnv, digest };
}

function run(files: ReturnType<typeof candidate>) {
  const work = join(files.root, 'work');
  const result = spawnSync('bash', [PUBLISH, '--archive', files.archive, '--work', work], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: hermeticEnv({ DRY_RUN: '1', PUI_RELEASE_HOST_ENV: files.hostEnv }),
  });
  return { result, work };
}

// Exercise the real publisher's write path with a local object store. Neither
// adapter can reach the network or inherit production storage credentials.
function publication(files: ReturnType<typeof candidate>, options: {
  headFailure?: boolean;
  corruptPublicArchive?: boolean;
  existingArchive?: 'identical-without-metadata' | 'different';
} = {}) {
  const bin = join(files.root, 'bin');
  mkdirSync(bin);
  const state = join(files.root, 'objects.json');
  const events = join(files.root, 'events.jsonl');
  const archiveKey = 'unguessable-prefix/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz';
  writeFileSync(state, JSON.stringify(options.existingArchive ? {
    [archiveKey]: { body: (options.existingArchive === 'different'
      ? Buffer.from('previous release') : readFileSync(files.archive)).toString('base64') },
  } : {}));
  writeFileSync(events, '');
  const adapter = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const store = JSON.parse(fs.readFileSync(process.env.MOCK_STORE, 'utf8'));
const arg = (name) => args[args.indexOf(name) + 1];
const log = (op, key) => fs.appendFileSync(process.env.MOCK_EVENTS, JSON.stringify({op,key}) + '\\n');
if (path.basename(process.argv[1]) === 'curl') {
  const url = new URL(args.find((value) => value.startsWith('https://')));
  const key = url.pathname.slice(1);
  log('public-get', key);
  if (!store[key]) process.exit(22);
  const body = process.env.MOCK_CORRUPT === '1' && key.endsWith('.tar.gz')
    ? Buffer.from('corrupt download') : Buffer.from(store[key].body, 'base64');
  fs.writeFileSync(arg('-o'), body);
} else if (args.includes('head-object')) {
  const key = arg('--key');
  log('head', key);
  if (process.env.MOCK_HEAD_FAILURE === '1') {
    console.error('An error occurred (AccessDenied) when calling HeadObject'); process.exit(1);
  }
  if (!store[key]) {
    console.error('An error occurred (404) when calling HeadObject'); process.exit(1);
  }
  console.log(store[key].sha || 'None');
} else if (args.includes('get-object')) {
  const key = arg('--key');
  log('authenticated-get', key);
  if (!store[key]) process.exit(1);
  fs.writeFileSync(args.at(-1), Buffer.from(store[key].body, 'base64'));
} else if (args.includes('cp')) {
  const index = args.indexOf('cp');
  const key = new URL(args[index + 2]).pathname.slice(1);
  log('put', key);
  store[key] = { body: fs.readFileSync(args[index + 1]).toString('base64'),
    ...(args.includes('--metadata') ? {sha: arg('--metadata').slice('sha256='.length)} : {}) };
  fs.writeFileSync(process.env.MOCK_STORE, JSON.stringify(store));
} else { console.error('unexpected mock invocation'); process.exit(2); }
`;
  for (const name of ['aws', 'curl']) writeFileSync(join(bin, name), adapter, { mode: 0o755 });
  const r2Env = join(files.root, 'r2.env');
  writeFileSync(r2Env, 'R2_ACCOUNT_ID=fixture\nR2_BUCKET=fixture\nAWS_ACCESS_KEY_ID=fixture\nAWS_SECRET_ACCESS_KEY=fixture\n');
  const portalEnv = join(files.root, 'portal-public-links.env');
  const work = join(files.root, 'published');
  const result = spawnSync('bash', [PUBLISH, '--archive', files.archive, '--work', work], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: hermeticEnv({ PATH: `${bin}:${process.env.PATH}`, DRY_RUN: '0',
      PUI_RELEASE_HOST_ENV: files.hostEnv, PUI_R2_ENV: r2Env,
      PUI_PORTAL_LINKS_ENV: portalEnv, PUI_SKIP_PORTAL_CONFIG: '0',
      MOCK_STORE: state, MOCK_EVENTS: events,
      MOCK_HEAD_FAILURE: options.headFailure ? '1' : '0',
      MOCK_CORRUPT: options.corruptPublicArchive ? '1' : '0' }),
  });
  return { result, portalEnv, work, archiveKey,
    events: readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; key: string }) };
}

describe('PUI public release publisher', () => {
  it('binds the accepted source and digest, renders distinct PUI links, and masks the host prefix', () => {
    const files = candidate();
    const { result, work } = run(files);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('validation passed');
    expect(result.stdout).not.toContain('unguessable-prefix');
    const latest = JSON.parse(readFileSync(join(work, 'latest.json'), 'utf8'));
    expect(latest).toMatchObject({
      version: '0.1.0',
      target: 'linux-x86_64',
      sourceSha: 'a'.repeat(40),
      archiveSha256: files.digest,
    });
    expect(latest.archiveUrl).toBe('https://pub.example.test/unguessable-prefix/pui/0.1.0/pui-0.1.0-linux-x86_64.tar.gz');
    const page = readFileSync(join(work, 'index.html'), 'utf8');
    expect(page).toContain(latest.archiveUrl);
    expect(page).toContain(`${files.digest}</code>`);
  });

  it('refuses a green-looking report bound to different archive bytes', () => {
    const files = candidate();
    const acceptance = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    acceptance.candidate.archiveSha256 = '0'.repeat(64);
    writeFileSync(files.acceptance, JSON.stringify(acceptance));
    const { result } = run(files);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('acceptance report belongs to different archive bytes');
  });

  it('omits private local paths, account details and terminal output from the public report', () => {
    const files = candidate();
    const report = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    report.candidate.archive = '/fixture/private-user/candidate.tar.gz';
    report.runner.stockMachines[0].output = 'PRIVATE_OUTPUT';
    report.runner.legs[0].evidence = '/fixture/private-user/private-evidence.json';
    report.evidence = [{ account: 'PRIVATE_ACCOUNT', token: 'PRIVATE_TOKEN' }];
    writeFileSync(files.acceptance, JSON.stringify(report));
    const { result, work } = run(files);
    expect(result.status, result.stderr).toBe(0);
    const published = readFileSync(join(work, 'pui-0.1.0-linux-x86_64.tar.gz.acceptance.json'), 'utf8');
    expect(published).not.toMatch(/PRIVATE|private-user/);
    expect(JSON.parse(published).candidate.archiveSha256).toBe(files.digest);
  });

  it('requires both stock images and a real leg for the advertised engine', () => {
    const files = candidate();
    const report = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    report.runner.stockMachines[1].image = 'ubuntu:24.04';
    writeFileSync(files.acceptance, JSON.stringify(report));
    expect(run(files).result.status).not.toBe(0);
    report.runner.stockMachines[1].image = 'debian:stable-slim';
    report.runner.legs.pop();
    writeFileSync(files.acceptance, JSON.stringify(report));
    expect(run(files).result.stderr).toContain('installed-product acceptance legs are absent or red');
  });

  it('refuses publication when the public cloud or stock-machine guard is absent', () => {
    const files = candidate();
    const acceptance = JSON.parse(readFileSync(files.acceptance, 'utf8'));
    acceptance.runner.cloudDeviceStart.ok = false;
    writeFileSync(files.acceptance, JSON.stringify(acceptance));
    const cloud = run(files).result;
    expect(cloud.status).not.toBe(0);
    expect(cloud.stderr).toContain('public cloud device-start guard did not pass');

    acceptance.runner.cloudDeviceStart.ok = true;
    acceptance.runner.stockMachines[1].status = 1;
    writeFileSync(files.acceptance, JSON.stringify(acceptance));
    const stock = run(files).result;
    expect(stock.status).not.toBe(0);
    expect(stock.stderr).toContain('passing Ubuntu and Debian stock-machine smoke');
  });

  it('verifies every public versioned file before advertising and installs distinct Portal links', () => {
    const files = candidate();
    const published = publication(files);
    expect(published.result.status, published.result.stderr).toBe(0);
    const { events } = published;
    const firstAdvertise = events.findIndex((row) => row.op === 'put' && row.key.endsWith('/latest.json'));
    for (const filename of ['pui-0.1.0-linux-x86_64.tar.gz', 'pui-0.1.0-linux-x86_64.tar.gz.acceptance.json', 'SHA256SUMS']) {
      const verified = events.findIndex((row) => row.op === 'public-get' && row.key.endsWith(`/${filename}`));
      expect(verified).toBeGreaterThan(-1);
      expect(verified).toBeLessThan(firstAdvertise);
    }
    expect(events.at(-1)).toEqual({ op: 'public-get', key: 'unguessable-prefix/pui/index.html' });
    expect(readFileSync(published.portalEnv, 'utf8')).toBe(
      'NEXT_PUBLIC_PORTAL_TUI_DOWNLOAD_URL=https://pub.example.test/unguessable-prefix/pui/index.html\n'
      + 'NEXT_PUBLIC_PORTAL_DESKTOP_DOWNLOAD_URL=https://pub.example.test/unguessable-prefix/index.html\n',
    );
  });

  it('fails closed on storage lookup errors without writing or configuring Portal', () => {
    const published = publication(candidate(), { headFailure: true });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('absence was not established');
    expect(published.events.some((row) => row.op === 'put')).toBe(false);
    expect(existsSync(published.portalEnv)).toBe(false);
  });

  it('compares existing bytes without metadata and repairs metadata only for identical content', () => {
    const published = publication(candidate(), { existingArchive: 'identical-without-metadata' });
    expect(published.result.status, published.result.stderr).toBe(0);
    expect(published.events).toContainEqual({ op: 'authenticated-get', key: published.archiveKey });
    expect(published.events).toContainEqual({ op: 'public-get', key: published.archiveKey });
  });

  it('refuses different immutable bytes before any upload', () => {
    const published = publication(candidate(), { existingArchive: 'different' });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('refusing to replace different bytes');
    expect(published.events.some((row) => row.op === 'put')).toBe(false);
  });

  it('never advertises or changes Portal when public archive bytes differ', () => {
    const published = publication(candidate(), { corruptPublicArchive: true });
    expect(published.result.status).not.toBe(0);
    expect(published.result.stderr).toContain('public archive bytes do not match');
    expect(published.events.filter((row) => row.op === 'put').every((row) => row.key.includes('/0.1.0/'))).toBe(true);
    expect(existsSync(published.portalEnv)).toBe(false);
  });
});
