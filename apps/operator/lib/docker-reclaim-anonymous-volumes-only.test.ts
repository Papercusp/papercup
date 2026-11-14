/**
 * docker-reclaim-anonymous-volumes-only.test.ts — RECURRENCE GUARD for WI-39305.
 *
 * The condition: this host's root filesystem (which holds BOTH $HOME and PGDATA)
 * filled to 99% while three successive CRITICAL work-items were filed and closed
 * by nobody — WI-38595 (90%), WI-38973 (95%), WI-39305 (99%). /var/lib/docker had
 * grown to 158 GiB, ~84 GiB of it pure garbage (build cache with zero active
 * references, unreferenced images, orphaned ANONYMOUS volumes) that no mechanism
 * ever reclaimed. `disk-space-alarm.ts` detects the condition but is read-only by
 * construction, so it had no actor on the other end (EI-20092729937622838:
 * 318 unheeded firings over 8 days under 1% free).
 *
 * `bin/reclaim-docker-disk.sh` is that actor. This guard exists because the
 * OBVIOUS way to write it is catastrophic:
 *
 *   `docker volume prune` deletes every DANGLING volume, NAMED ONES INCLUDED.
 *
 * On the measured box, 11 of the 154 dangling volumes were named persistent
 * application data — bytebot_postgres_data and the bytebot-pool_bytebot-N-postgres-data
 * set, automaker-*, sheets-clone*, litellm_litellm_pgdata, sidestage_*, the whole
 * restart_* family (odoo / plane / twenty / outline / chatwoot / vikunja / appflowy),
 * stalwart-agenticmail-data. They were "dangling" only because their services
 * happened not to be running at that moment. A blanket prune destroys all of them,
 * silently, and the loss is not recoverable from anywhere on this box.
 *
 * So the script removes ONLY volumes whose name is a Docker ANONYMOUS id
 * (^[0-9a-f]{64}$), which are ephemeral by definition. Anything a human or a
 * compose file NAMED is never a candidate.
 *
 * Test shape: a `readFileSync` wiring guard for the safety-critical prohibitions
 * (same rationale as the sibling live-federation-gate-sidecar-reaper.test.ts — the
 * script drives a real docker daemon, so its safety wiring can only be asserted at
 * the wiring site), PLUS a BEHAVIORAL check of the safety-critical half: the
 * classification pattern is extracted FROM THE SCRIPT ITSELF and evaluated against
 * real volume names observed on this box. That is what makes the guard falsifiable
 * rather than decorative — weakening the regex (say to `.*`, or dropping an anchor)
 * fails the behavioral assertions even though every text assertion still passes.
 *
 * PROBE_SCRIPT overrides the subject path so falsifiability can be proven against a
 * mutated COPY outside the tree (CLAUDE.md mutation-probe tier 2) — never by
 * mutating the shared tree, where the git-sync sweep can commit the mutant.
 */
import { existsSync, readFileSync, statSync, lstatSync, linkSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createRetentionPin } from '../../../packages/operator-core/lib/storage/retention-pins';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';

const SCRIPT = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : resolve(__dirname, '../../../bin/reclaim-docker-disk.sh');

const REAL_PYTHON = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
const REAL_DU = execFileSync('bash', ['-c', 'command -v du'], { encoding: 'utf8' }).trim();
const src = readFileSync(SCRIPT, 'utf8');
const censusSource = src.match(/const census = String\.raw\x60([\s\S]*?)\x60;/)?.[1];
  // The census owns a 30 s budget; leave enough outer time for its structured
  // timeout receipt to reach the assertion and ledger.
  const fixtureTimeoutMs = 40_000;
  vi.setConfig({ testTimeout: fixtureTimeoutMs + 5_000 });

/** Strip comment-only lines so prohibitions match EXECUTABLE shell, not the docblock
 *  (which deliberately names `docker volume prune` in order to forbid it). */
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** Real NAMED volumes observed on this box 2026-08-15 — every one of these was
 *  simultaneously "dangling" and irreplaceable persistent application data. */
const REAL_NAMED_VOLUMES = [
  'bytebot_postgres_data',
  'bytebot-pool_bytebot-1-postgres-data',
  'bytebot-pool_bytebot-10-postgres-data',
  'automaker-data',
  'automaker-opencode-cache',
  'sheets-clone_api-data',
  'sheets-clone--production_api-data-prod',
  'litellm_litellm_pgdata',
  'sidestage_sidestage-postgres',
  'sidestage-data_sidestage-typesense-data',
  'restart_odoo-pg-data',
  'restart_plane-minio-data',
  'restart_twenty-db-data',
  'restart_outline-postgres-data',
  'stalwart-agenticmail-data',
  'papercusp-scratch-f-autofit-001-1-hsdbnh1j_api-data',
];

/** Real ANONYMOUS volume ids (64 lowercase hex) — Docker's own ephemeral naming. */
const REAL_ANONYMOUS_VOLUMES = [
  'f078706e316d7446c30979d5defa2d2274f89615faff4cca3c28f9405b218ae2',
  'fc224d92d5a2b53a64498d192ccd6aacf2e99a614449689bdf7150b1bc531e33',
  'fef1e1bcfb858c5358d8f50fd13aca56b4ba63b88873a2edd0f51cdddf18d8cf',
];

/** Pull the anonymous-id pattern out of the script's own grep, so the behavioral
 *  assertions below test the SHIPPING classifier rather than a copy of it. */
function extractAnonymousPattern(): RegExp {
  const m = code.match(/grep\s+-E\s+'(\^[^']*\$)'/);
  if (!m) throw new Error('no anchored `grep -E` volume-classification pattern found in script');
  return new RegExp(m[1]);
}

describe('WI-39305 — docker reclaim removes ONLY anonymous volumes', () => {
  it('the script exists and is executable', () => {
    expect(existsSync(SCRIPT)).toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  // ── The safety-critical prohibitions ───────────────────────────────────────

  it('NEVER invokes the blanket `docker volume prune`', () => {
    // This is the whole reason the guard exists: `volume prune` cannot distinguish
    // an orphaned testcontainer volume from bytebot_postgres_data.
    expect(code).not.toMatch(/volume\s+prune/);
  });

  it('NEVER invokes `docker system prune`', () => {
    // `system prune --volumes` is `volume prune` wearing a hat; the bare form also
    // reaches containers and networks this script has no business touching.
    expect(code).not.toMatch(/system\s+prune/);
  });

  it('removes volumes only via an explicitly anchored anonymous-id filter', () => {
    expect(code).toMatch(/volume\s+rm/);
    expect(code).toMatch(/grep\s+-E\s+'\^\[0-9a-f\]\{64\}\$'/);
  });

  it('age-filters cache and image sweeps so an in-flight build is never disturbed', () => {
    expect(code).toMatch(/builder\s+prune[^\n]*--filter\s+"until=/);
    expect(code).toMatch(/image\s+prune[^\n]*--filter\s+"until=/);
  });

  it('does not use `set -e`; unavailable daemons remain logged no-ops', () => {
    expect(code).toMatch(/^set -uo pipefail$/m);
    expect(code).not.toMatch(/^set -euo/m);
  });

  // ── The behavioral half — the classifier as it actually ships ──────────────

  describe('the shipping classifier', () => {
    const pattern = extractAnonymousPattern();

    it.each(REAL_NAMED_VOLUMES)('SPARES the named volume %s', (name) => {
      expect(pattern.test(name)).toBe(false);
    });

    it.each(REAL_ANONYMOUS_VOLUMES)('claims the anonymous volume %s', (id) => {
      expect(pattern.test(id)).toBe(true);
    });

    it('is anchored at BOTH ends — a named volume that merely CONTAINS a hex run is spared', () => {
      // Without the anchors, `prefix-<64 hex>-suffix` would match and a named
      // volume built around a hash would be destroyed.
      const hex = REAL_ANONYMOUS_VOLUMES[0];
      expect(pattern.test(`backup-${hex}`)).toBe(false);
      expect(pattern.test(`${hex}-keep`)).toBe(false);
    });

    it('rejects near-misses that are not Docker anonymous ids', () => {
      expect(pattern.test('f078706e')).toBe(false); // too short
      expect(pattern.test('F078706E316D7446C30979D5DEFA2D2274F89615FAFF4CCA3C28F9405B218AE2')).toBe(false); // uppercase
      expect(pattern.test(`${REAL_ANONYMOUS_VOLUMES[0]}a`)).toBe(false); // too long
    });
  });
});

describe('Podman stores use the existing guarded image policy', () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'reclaim-container-fixture-'));
    const log = join(root, 'calls');
    const unshareLog = join(root, 'unshare-calls');
    const duLog = join(root, 'du-calls');
    const duCounter = join(root, 'du-counter');
    const executable = (name: string, body: string) => writeFileSync(join(root, name), '#!/bin/bash\n' + body, { mode: 0o755 });
    for (const name of ['docker', 'rootless', 'rootful']) mkdirSync(join(root, 'stores', name), { recursive: true });
    executable('docker', '[[ "${DOCKER_UP:-0}" == 1 ]] || exit 1\nif [[ "$1" == info ]]; then [[ "$*" != *--format* ]] || echo "$FIXTURE_ROOT/stores/docker"; exit 0; fi\nprintf "docker %s\\n" "$*" >>"$FIXTURE_LOG"\n');
    executable('sudo', '[[ "$1" == "-n" ]] && shift\nexport STORE=rootful\nexec "$@"\n');
    executable('podman', 'if [[ "$1" == "info" ]]; then [[ "$*" != *--format* ]] || echo "${FIXTURE_ALIAS:-$FIXTURE_ROOT/stores/${STORE:-rootless}}"; exit "${PODMAN_DOWN:-0}"; fi\nif [[ "$1" == "unshare" ]]; then printf "podman unshare python3\\n" >>"$FIXTURE_UNSHARE_LOG"; shift; export FIXTURE_PODMAN_UNSHARE=1; exec "$@"; fi\nprintf "%s %s\\n" "${STORE:-rootless}" "$*" >>"$FIXTURE_LOG"\nif [[ -n "${FIXTURE_PAUSE:-}" && "${STORE:-rootless}" == rootless ]]; then touch "$FIXTURE_PAUSE"; while [[ ! -e "$FIXTURE_PAUSE.continue" ]]; do sleep 0.01; done; fi\nexit "${FIXTURE_NATIVE_EXIT:-0}"\n');
    executable('df', 'if [[ "$*" == *--output=avail* ]]; then if [[ -n "$FIXTURE_AVAILABLE_AFTER" && -f "$FIXTURE_DF_COUNTER" ]]; then echo "$FIXTURE_AVAILABLE_AFTER"; else value="$FIXTURE_AVAILABLE"; [[ -n "$value" ]] || value=100000000000; echo "$value"; touch "$FIXTURE_DF_COUNTER"; fi; else echo 100000000000; fi\n');
    const env = { ...process.env, PATH: root + ':' + process.env.PATH, FIXTURE_ROOT: root, FIXTURE_LOG: log,
      PAPERCUSP_RELEASE_RETENTION_ROOT: join(root, 'pins'), PAPERCUSP_FS_MUTEX_LOCK_DIR: join(root, 'mutex'),
      FIXTURE_DF_COUNTER: join(root, 'df-counter'),
      FIXTURE_REAL_PYTHON: REAL_PYTHON, FIXTURE_UNSHARE_LOG: unshareLog,
      FIXTURE_REAL_DU: REAL_DU, FIXTURE_DU_LOG: duLog, FIXTURE_DU_COUNTER: duCounter,
      PAPERCUSP_FS_MUTEX_TIMEOUT_MS: '2000', DRY_RUN: '0', SKIP_IMAGES: '0', SKIP_TESTCONTAINERS: '1',
      FIXTURE_ALIAS: '', IMAGE_MAX_AGE: '168h', RECLAIM_MIN_FREE_PCT: '101' };
    const installFailedCensus = () => executable('python3',
      'if [[ "$1" == "-c" ]]; then echo \'{"complete":false,"permissionDenied":false,"error":"filesystem boundary"}\'; exit 0; fi\nexit 97\n');
    const installNamespaceAwareCensus = () => executable('python3',
      'if [[ "$1" == "-c" && "${STORE:-rootless}" == rootless && "${FIXTURE_PODMAN_UNSHARE:-0}" != 1 ]]; then echo \'{"complete":false,"permissionDenied":true,"error":"permission denied outside Podman user namespace"}\'; exit 0; fi\nexec "$FIXTURE_REAL_PYTHON" "$@"\n');
    const installSinglePassCensus = () => {
      executable('find', 'printf "find\\n" >>"$FIXTURE_DU_LOG"; exit 97\n');
      executable('du', 'printf "du\\n" >>"$FIXTURE_DU_LOG"; exec "$FIXTURE_REAL_DU" "$@"\n');
    };
    const installFailFirstDu = () => executable('du',
      'printf "du\\n" >>"$FIXTURE_DU_LOG"\nif [[ ! -e "$FIXTURE_DU_COUNTER" ]]; then touch "$FIXTURE_DU_COUNTER"; echo "synthetic first-pass failure" >&2; exit 23; fi\nexec "$FIXTURE_REAL_DU" "$@"\n');
    return {
      root, env,
      calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
      unshareCalls: () => existsSync(unshareLog) ? readFileSync(unshareLog, 'utf8').trim().split('\n') : [],
      nativeCalls: () => existsSync(duLog) ? readFileSync(duLog, 'utf8').trim().split('\n') : [],
      installFailedCensus,
      installNamespaceAwareCensus,
      installSinglePassCensus,
      installFailFirstDu,
    };
  };
  const pin = (f: ReturnType<typeof fixture>, path: string, expired = false) => {
    const nowMs = Date.now() - (expired ? 120_000 : 0);
    return createRetentionPin({ path, owner: 'fixture', reason: 'review', expiresAt: new Date(nowMs + 60_000).toISOString() },
      { dir: f.env.PAPERCUSP_RELEASE_RETENTION_ROOT, nowMs });
  };
  const runFixture = (overrides: Record<string, string> = {}, prepare?: (f: ReturnType<typeof fixture>) => void,
    expectedStatus = 0) => {
    const f = fixture();
    try {
      prepare?.(f);
      let output = '';
      let status = 0;
      try {
        output = execFileSync('timeout', ['--signal=TERM', '--kill-after=1s', `${fixtureTimeoutMs / 1000}s`,
          'bash', SCRIPT], { encoding: 'utf8', timeout: fixtureTimeoutMs + 2000,
          env: { ...f.env, ...overrides } });
      } catch (error) {
        const failure = error as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        const captured = (value?: string | Buffer) => typeof value === 'string'
          ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
        const actualStatus = typeof failure.status === 'number' ? failure.status : null;
        if (actualStatus !== expectedStatus) {
          throw new Error('expected reclaim script exit ' + expectedStatus + ', got ' + actualStatus
            + ': ' + (failure.message ?? 'unknown failure') + '\nstdout:\n' + captured(failure.stdout)
            + '\nstderr:\n' + captured(failure.stderr));
        }
        status = actualStatus as number;
        output = captured(failure.stdout);
      }
      const receipts = output.split('\n').filter(line => line.startsWith('[docker-reclaim] store-receipt '))
        .map(line => JSON.parse(line.slice('[docker-reclaim] store-receipt '.length)));
      return { output, calls: f.calls(), receipts, status, unshareCalls: f.unshareCalls(), nativeCalls: f.nativeCalls() };
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  };

  it('retains a Docker store with a whole-store pin while other stores still collect', () => {
    const result = runFixture({ DOCKER_UP: '1' }, f => pin(f, join(f.root, 'stores/docker')));
    expect(result.calls.some(call => call.startsWith('docker '))).toBe(false);
    expect(result.calls).toHaveLength(2);
    expect(result.output).toContain('retention pin protects docker');
  });

  it('runs native cleanup when pin admission succeeds but the allocation census hits a boundary', () => {
    const result = runFixture({}, f => f.installFailedCensus(), 1);
    expect(result.calls).toEqual([
      'rootless image prune -af --filter until=168h',
      'rootful image prune -af --filter until=168h',
    ]);
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.every(r => r.measurementComplete === false && r.complete === false
      && r.error.includes('filesystem boundary'))).toBe(true);
    expect(result.status).toBe(1);
    expect(result.output).toContain('returning failure for systemd health visibility');
  });

  it('retries rootless census in the Podman user namespace after a permission denial', () => {
    const result = runFixture({}, f => f.installNamespaceAwareCensus());
    const rootless = result.receipts.find(r => r.store === 'podman-rootless');
    expect(result.status).toBe(0);
    expect(result.unshareCalls).toEqual(['podman unshare python3', 'podman unshare python3']);
    expect(rootless).toMatchObject({ measurementComplete: true, complete: true, status: 'within-cap' });
  });

  it('keeps one-filesystem boundaries and ignores pin roots outside the physical store', () => {
    expect(censusSource).toBeTruthy();
    expect(censusSource).toContain('"--one-file-system"');
    expect(censusSource).toContain('"--no-dereference"');
    const root = mkdtempSync(join(tmpdir(), 'reclaim-census-boundary-'));
    try {
      const nested = join(root, 'nested');
      mkdirSync(nested);
      const payload = join(nested, 'payload');
      writeFileSync(payload, Buffer.alloc(65_536));
      const expectedBytes = (lstatSync(root).blocks + lstatSync(nested).blocks
        + lstatSync(payload).blocks) * 512;
      const result = JSON.parse(execFileSync(REAL_PYTHON, ['-c', censusSource], {
        encoding: 'utf8', timeout: 10_000, input: JSON.stringify({ root, pins: ['/proc'] }),
      }));
      expect(result).toMatchObject({ complete: true, pinnedBytes: 0, bytes: expectedBytes });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses native allocation accounting with global hardlink and pin deduplication', () => {
    expect(censusSource).toBeTruthy();
    const root = mkdtempSync(join(tmpdir(), 'reclaim-census-parallel-'));
    try {
      const parallel = join(root, 'parallel');
      mkdirSync(parallel);
      const dirs = Array.from({ length: 4 }, (_, index) => join(parallel, 'entry-' + index));
      for (const directory of dirs) mkdirSync(directory);
      const paths = dirs.map(directory => join(directory, 'payload'));
      for (const path of paths) writeFileSync(path, Buffer.alloc(8192));
      linkSync(paths[0], join(root, 'outside-hardlink'));
      const outsidePayload = join(root, 'outside-payload');
      writeFileSync(outsidePayload, Buffer.alloc(4096));
      const symlink = join(parallel, 'outside-link');
      symlinkSync(outsidePayload, symlink);
      const bytes = (lstatSync(root).blocks + lstatSync(parallel).blocks
        + dirs.reduce((sum, path) => sum + lstatSync(path).blocks, 0)
        + paths.reduce((sum, path) => sum + lstatSync(path).blocks, 0)
        + lstatSync(outsidePayload).blocks + lstatSync(symlink).blocks) * 512;
      const pinnedBytes = (lstatSync(parallel).blocks
        + dirs.reduce((sum, path) => sum + lstatSync(path).blocks, 0)
        + paths.reduce((sum, path) => sum + lstatSync(path).blocks, 0)
        + lstatSync(symlink).blocks) * 512;
      const result = JSON.parse(execFileSync(REAL_PYTHON, ['-c', censusSource], {
        encoding: 'utf8', timeout: 10_000, input: JSON.stringify({ root, pins: [parallel, dirs[0]] }),
      }));
      expect(result).toMatchObject({ complete: true, bytes, pinnedBytes });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a live store pin blocking native cleanup when the allocation census fails', () => {
    const result = runFixture({}, f => {
      f.installFailedCensus();
      pin(f, join(f.root, 'stores/rootless'));
    }, 1);
    expect(result.calls).toEqual(['rootful image prune -af --filter until=168h']);
    expect(result.output).toContain('retention pin protects podman-rootless');
  });

  it('protects a custom physical Podman store through its logical alias', () => {
    const result = runFixture({}, f => {
      const child = join(f.root, 'stores/rootless/evidence'); mkdirSync(child); pin(f, child);
      const alias = join(f.root, 'alias'); symlinkSync(join(f.root, 'stores/rootless'), alias);
      f.env.FIXTURE_ALIAS = alias;
    });
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('retention pin protects podman-rootless');
  });

  it('expired pins restore native collection and sibling prefixes remain eligible', () => {
    const result = runFixture({}, f => {
      pin(f, join(f.root, 'stores/rootless'), true);
      const sibling = join(f.root, 'stores/rootful-other'); mkdirSync(sibling); pin(f, sibling);
    });
    expect(result.calls).toHaveLength(2);
  });

  it('refuses native mutation and reports unmeasured stores when retention is malformed', () => {
    const result = runFixture({ DOCKER_UP: '1' }, f => {
      mkdirSync(f.env.PAPERCUSP_RELEASE_RETENTION_ROOT);
      writeFileSync(join(f.env.PAPERCUSP_RELEASE_RETENTION_ROOT, 'lease-broken.tsv'), 'broken');
    }, 1);
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('retention pin admission failed');
    expect(result.status).toBe(1);
    expect(result.output).toContain('returning failure for systemd health visibility');
  });

  it('holds the shared pin mutex until the native prune command finishes', async () => {
    const f = fixture(); const pause = join(f.root, 'pruning');
    const running = promisify(execFile)('bash', [SCRIPT], { env: { ...f.env, FIXTURE_PAUSE: pause }, timeout: 10_000 });
    let entered = false;
    let writer: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(pause)).toBe(true), { timeout: 3000 });
      vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', f.env.PAPERCUSP_FS_MUTEX_LOCK_DIR);
      writer = withFsMutex('papercusp-disk-retention', async () => { entered = true; },
        { timeoutMs: 5000, retryMs: 10 });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(entered).toBe(false);
    } finally {
      writeFileSync(pause + '.continue', '');
      await running;
      await writer;
      vi.unstubAllEnvs();
      rmSync(f.root, { recursive: true, force: true });
    }
    expect(entered).toBe(true);
  });

  it('collects only old unused images in both Podman stores even when Docker is unavailable', () => {
    const result = runFixture();
    expect(result.calls).toEqual([
      'rootless image prune -af --filter until=168h',
      'rootful image prune -af --filter until=168h',
    ]);
    expect(result.calls.join('\n')).not.toMatch(/--external|volume|container|system/);
  });

  it('previews both stores without invoking either prune', () => {
    const result = runFixture({ DRY_RUN: '1' });
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('DRY_RUN would run: podman image prune -af --filter until=168h');
    expect(result.output).toContain('DRY_RUN would run: sudo -n podman image prune -af --filter until=168h');
  });

  it('does not attribute unrelated free-space changes to cleanup during DRY_RUN', () => {
    const result = runFixture({ DRY_RUN: '1', FIXTURE_AVAILABLE: '1000000000', FIXTURE_AVAILABLE_AFTER: '2000000000' });
    expect(result.output).toContain('dry-run observed df delta: 953 MiB; not attributed to this run');
    expect(result.output).not.toContain('MiB reclaimed');
    expect(result.receipts.every(r => r.reclaimedBytes === 0)).toBe(true);
  });

  it('honors the existing image-sweep kill switch for both Podman stores', () => {
    expect(runFixture({ SKIP_IMAGES: '1' }).calls).toEqual([]);
  });

  it('collects only twelve-hour unused images below the shared write reserve', () => {
    const result = runFixture({ FIXTURE_AVAILABLE: '1000000000', IMAGE_MAX_AGE: '' });
    expect(result.calls).toEqual([
      'rootless image prune -af --filter until=12h',
      'rootful image prune -af --filter until=12h',
    ]);
    expect(result.calls.join('\n')).not.toMatch(/--external|volume|container|system/);
  });

  it('keeps an explicit operator age override during critical pressure', () => {
    const result = runFixture({ FIXTURE_AVAILABLE: '1000000000', IMAGE_MAX_AGE: '72h' });
    expect(result.calls.every(call => call.endsWith('until=72h'))).toBe(true);
  });

  it('keeps the ordinary retention window when free space is at the reserve', () => {
    const result = runFixture({ FIXTURE_AVAILABLE: '2000000000', IMAGE_MAX_AGE: '' });
    expect(result.calls.every(call => call.endsWith('until=168h'))).toBe(true);
  });

  it('keeps the kill switch effective during critical pressure', () => {
    expect(runFixture({ FIXTURE_AVAILABLE: '1000000000', IMAGE_MAX_AGE: '', SKIP_IMAGES: '1' }).calls).toEqual([]);
  });

  it('leaves unavailable Podman stores alone', () => {
    const result = runFixture({ PODMAN_DOWN: '1' });
    expect(result.calls).toEqual([]);
    expect(result.output).toContain('podman-rootful unreachable');
  });

  it('measures configured physical stores including root inodes and reports unrelated cap residue', () => {
    let expectedBytes = 0;
    const result = runFixture({ CONTAINER_STORE_MAX_BYTES: '1' }, f => {
      const root = join(f.root, 'stores/rootless');
      const bulk = join(root, 'bulk'); writeFileSync(bulk, Buffer.alloc(16_384));
      expectedBytes = (lstatSync(root).blocks + lstatSync(bulk).blocks) * 512;
    });
    const receipt = result.receipts.find(r => r.store === 'podman-rootless');
    expect(receipt).toMatchObject({ maxBytes: 1, measurementComplete: true, complete: false,
      status: 'unprotected-overage', nativeFailures: 0, pinnedBytes: 0 });
    expect(receipt.afterBytes).toBe(expectedBytes);
    expect(receipt.unprotectedOverageBytes).toBe(receipt.afterBytes - 1);
    expect(receipt.physicalRoot).toContain('/stores/rootless');
  });

  it('deduplicates aliases by physical store identity before native commands', () => {
    const result = runFixture({}, f => { f.env.FIXTURE_ALIAS = join(f.root, 'stores/rootless'); });
    expect(result.calls).toEqual(['rootless image prune -af --filter until=168h']);
    expect(result.receipts.map(r => r.status)).toEqual(['within-cap', 'duplicate-store']);
  });

  it('reports native failure independently of residual size while preserving timer compatibility', () => {
    const result = runFixture({ FIXTURE_NATIVE_EXIT: '23' });
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.every(r => r.status === 'native-failed' && r.nativeFailures === 1 && !r.complete)).toBe(true);
    expect(result.receipts.every(r => r.measurementComplete && r.unprotectedOverageBytes === 0)).toBe(true);
  });

  it('keeps exact pin allocation separate from sibling bulk and hardlink aliases', () => {
    let pinnedBytes = 0; let totalBytes = 0;
    const result = runFixture({ CONTAINER_STORE_MAX_BYTES: '1' }, f => {
      const root = join(f.root, 'stores/rootless');
      const child = join(root, 'pinned'); mkdirSync(child);
      const file = join(child, 'evidence'); writeFileSync(file, Buffer.alloc(8192));
      linkSync(file, join(root, 'outside-link'));
      writeFileSync(join(root, 'bulk'), Buffer.alloc(32_768));
      // A symlink out of the store contributes its own inode, never its target.
      const outside = join(f.root, 'outside'); writeFileSync(outside, Buffer.alloc(65_536));
      const alias = join(root, 'outside-symlink'); symlinkSync(outside, alias);
      pinnedBytes = (lstatSync(child).blocks + lstatSync(file).blocks) * 512;
      totalBytes = (lstatSync(root).blocks + lstatSync(child).blocks + lstatSync(file).blocks
        + lstatSync(join(root, 'bulk')).blocks + lstatSync(alias).blocks) * 512;
      pin(f, child);
    });
    const receipt = result.receipts.find(r => r.store === 'podman-rootless');
    expect(receipt).toMatchObject({ status: 'pinned-unrelated-overage', complete: false,
      measurementComplete: true, beforeBytes: totalBytes, afterBytes: totalBytes, pinnedBytes });
    expect(receipt.unprotectedOverageBytes).toBe(totalBytes - pinnedBytes);
    expect(result.calls.every(call => !call.startsWith('rootless '))).toBe(true);
  });

  it('accepts only pin-explained overage while leaving a whole pinned store untouched', () => {
    const result = runFixture({ CONTAINER_STORE_MAX_BYTES: '1' }, f => {
      writeFileSync(join(f.root, 'stores/rootless/evidence'), Buffer.alloc(8192));
      pin(f, join(f.root, 'stores/rootless'));
    });
    const receipt = result.receipts.find(r => r.store === 'podman-rootless');
    expect(receipt).toMatchObject({ status: 'pinned-overage', complete: true, unprotectedOverageBytes: 0 });
    expect(receipt.pinnedBytes).toBe(receipt.afterBytes);
    expect(result.calls.every(call => !call.startsWith('rootless '))).toBe(true);
  });

  it('uses one native du traversal per measurement and never starts a recursive find walk', () => {
    const result = runFixture({ DOCKER_UP: '1', PODMAN_DOWN: '1', DRY_RUN: '1' },
      f => f.installSinglePassCensus());
    const receipt = result.receipts.find(r => r.store === 'docker');
    expect(result.nativeCalls).toEqual(['du', 'du']);
    expect(receipt).toMatchObject({ measurementComplete: true, status: 'dry-run' });
  });

  it('keeps a failed before census visible while sweeping without a redundant after scan', () => {
    const result = runFixture({ DOCKER_UP: '1', PODMAN_DOWN: '1' }, f => {
      f.installSinglePassCensus();
      f.installFailFirstDu();
    }, 1);
    const receipt = result.receipts.find(r => r.store === 'docker');
    expect(result.nativeCalls).toEqual(['du']);
    expect(result.calls.some(call => call.startsWith('docker builder prune'))).toBe(true);
    expect(result.calls.some(call => call.startsWith('docker image prune'))).toBe(true);
    expect(result.status).toBe(1);
    expect(receipt).toMatchObject({ measurementComplete: false, complete: false, status: 'measurement-failed' });
    expect(receipt.error).toContain('before:');
    expect(receipt.error).toContain('skipped because before measurement failed');
  });
});
