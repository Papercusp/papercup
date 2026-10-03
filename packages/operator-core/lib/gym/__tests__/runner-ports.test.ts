import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGymRunnerPorts, parseVitestOracleResults, type GymRunnerPortsConfig } from '../runner-ports';
import type { Sql } from 'postgres';

/** A no-op tagged-template + `.unsafe()`/`.json()` sql fake (teardown + principal-seed paths). */
function fakeSql(): Sql {
  const tag = (async () => []) as unknown as Sql;
  (tag as unknown as { unsafe: (s: string) => Promise<unknown[]> }).unsafe = async () => [];
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return tag;
}

/**
 * Real GymRunnerPorts adapter (P-001 wiring). Binds the smoke-PROVEN operations:
 * git clone, harness register (HTTP), prompt overrides + feature (gym PG), pipeline
 * start (admin route + superuser bearer), poll (gym PG), teardown. The HTTP + exec
 * ports are tested here with injected fakes (verifying URLs/auth/commands); the gym-PG
 * ports are validated by the boot smoke / P-014.
 */
function cfg(over: Partial<GymRunnerPortsConfig> = {}): { config: GymRunnerPortsConfig; reqs: { url: string; init: RequestInit }[]; execs: string[][] } {
  const reqs: { url: string; init: RequestInit }[] = [];
  const execs: string[][] = [];
  const config: GymRunnerPortsConfig = {
    operatorBaseUrl: 'http://127.0.0.1:3971',
    gymSql: fakeSql(), // registerThrowawayHarness seeds principals through it before the HTTP call
    superuserToken: 'sekret-token-1234567890',
    workspaceId: 'gym-ws',
    fetchFn: (async (url: string, init: RequestInit) => {
      reqs.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({ ok: true, workflowID: 'pipeline:gymx:F-GYM-1:e0' }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
    exec: async (cmd: string, args: string[]) => {
      execs.push([cmd, ...args]);
    },
    rm: async () => {},
    ...over,
  };
  return { config, reqs, execs };
}

describe('createGymRunnerPorts', () => {
  it('retains skipped assertion identities so they cannot disappear from coverage', () => {
    expect(parseVitestOracleResults(JSON.stringify({ testResults: [{ assertionResults: [
      { fullName: 'executed', status: 'passed' }, { fullName: 'skipped', status: 'pending' },
    ] }] }))).toEqual([
      { name: 'executed', passed: true },
      { name: 'skipped', passed: false, executed: false },
    ]);
  });

  it('exposes the full GymRunnerPorts surface', () => {
    const p = createGymRunnerPorts(cfg().config);
    for (const k of ['cloneSubstrate', 'registerThrowawayHarness', 'applyPromptOverride', 'fileFeature', 'startPipeline', 'pollStatus', 'runOracle', 'teardownHarness', 'now', 'sleep'] as const) {
      expect(typeof p[k]).toBe('function');
    }
  });

  it('default runOracle executes the supported test:file command and parses measured Vitest assertions', async () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-'));
    try {
      const { config, execs } = cfg({
        execCapture: async (_cmd, args) => {
          const outputArg = args.find((arg) => arg.startsWith('--outputFile='));
          expect(outputArg).toBeTruthy();
          writeFileSync(outputArg!.slice('--outputFile='.length), JSON.stringify({
            testResults: [{
              assertionResults: [
                { fullName: 'oracle > passes', status: 'passed' },
                { fullName: 'oracle > fails', status: 'failed' },
                { fullName: 'oracle > skipped', status: 'skipped' },
              ],
            }],
          }));
          return { stdout: '', stderr: '' };
        },
      });
      const p = createGymRunnerPorts(config);
      const results = await p.runOracle!({ clonePath, testPath: 'oracle.test.js' });
      expect(results).toEqual([
        { name: 'oracle > passes', passed: true },
        { name: 'oracle > fails', passed: false },
        { name: 'oracle > skipped', passed: false, executed: false },
      ]);
      expect(execs).toEqual([]);
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it.each([false, true])('captures the actual pinned oracle and bytes around execution (mutated=%s)', async (mutated) => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-pin-'));
    const original = 'export const oracle = true;\n';
    const changed = 'export const oracle = false;\n';
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      writeFileSync(join(clonePath, 'oracle.test.js'), original);
      const commands: string[][] = [];
      const { config } = cfg({ execCapture: async (cmd, args) => {
        commands.push([cmd, ...args]);
        if (cmd === 'git') return { stdout: original, stderr: '' };
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify({ testResults: [
          { name: join(clonePath, 'oracle.test.js'), assertionResults: [{ fullName: 't', status: 'passed' }] },
        ] }));
        if (mutated) writeFileSync(join(clonePath, 'oracle.test.js'), changed);
        return { stdout: '', stderr: '' };
      } });
      const pinCommit = 'a'.repeat(40);
      expect(await createGymRunnerPorts(config).runOracle!({ clonePath, testPath: 'oracle.test.js', pinCommit })).toMatchObject({
        results: [{ name: 't', file: 'oracle.test.js', passed: true }], testPath: 'oracle.test.js', pinCommit,
        sourceHashes: { pinned: digest(original), before: digest(original), after: digest(mutated ? changed : original) },
      });
      expect(commands[0]).toEqual(['git', 'show', `${pinCommit}:oracle.test.js`]);
      expect(commands[1].slice(0, 5)).toEqual(['npm', 'run', 'test:file', '--', 'oracle.test.js']);
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it('retains explicit unknown source identity when the immutable pin cannot be read', async () => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-missing-pin-'));
    try {
      writeFileSync(join(clonePath, 'oracle.test.js'), 'oracle');
      const { config } = cfg({ execCapture: async (cmd, args) => {
        if (cmd === 'git') throw new Error('missing commit');
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), JSON.stringify({ testResults: [{
          name: 'oracle.test.js', assertionResults: [{ fullName: 't', status: 'passed' }],
        }] }));
        return { stdout: '', stderr: '' };
      } });
      const receipt = await createGymRunnerPorts(config).runOracle!({ clonePath, testPath: 'oracle.test.js', pinCommit: 'a'.repeat(40) });
      expect(receipt).toMatchObject({ results: [{ name: 't', file: 'oracle.test.js', passed: true }],
        sourceHashes: { pinned: null } });
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it.each([false, true])('retains the exact evaluated implementation and raw test report (mutated=%s)', async (mutated) => {
    const clonePath = mkdtempSync(join(tmpdir(), 'gym-oracle-artifact-'));
    const before = 'export const answer = 42;\n';
    const after = 'export const answer = 0;\n';
    const report = JSON.stringify({ testResults: [{ name: join(clonePath, 'oracle.test.js'),
      assertionResults: [{ fullName: 'task', status: 'passed' }] }] });
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    try {
      writeFileSync(join(clonePath, 'impl.js'), before);
      writeFileSync(join(clonePath, 'oracle.test.js'), 'oracle');
      const { config } = cfg({ execCapture: async (cmd, args) => {
        if (cmd === 'git') return { stdout: 'oracle', stderr: '' };
        const outputArg = args.find((arg) => arg.startsWith('--outputFile='))!;
        writeFileSync(outputArg.slice('--outputFile='.length), report);
        if (mutated) writeFileSync(join(clonePath, 'impl.js'), after);
        return { stdout: '', stderr: '' };
      } });
      const input = { clonePath, testPath: 'oracle.test.js', implPath: 'impl.js', pinCommit: 'a'.repeat(40) };
      const receipt = await createGymRunnerPorts(config).runOracle!(input);
      expect(receipt).toMatchObject({
        implementation: { path: 'impl.js', before: hash(before), after: hash(mutated ? after : before) },
        execution: { cwd: clonePath, report,
          command: ['npm', 'run', 'test:file', '--', 'oracle.test.js', '--', '--reporter=json', expect.stringMatching(/^--outputFile=/)],
          unresolved: ['oracle-imported-dependencies', 'test-command-runtime', 'pipeline-runtime'] },
      });
    } finally { rmSync(clonePath, { recursive: true, force: true }); }
  });

  it('retains file collection failures and handles malformed reports as unmeasured', () => {
    expect(parseVitestOracleResults(JSON.stringify({ testResults: [{ name: 'broken.test.ts', assertionResults: [] }] })))
      .toEqual([{ name: '', file: 'broken.test.ts', passed: false, executed: false }]);
    expect(parseVitestOracleResults('null')).toEqual([]);
    expect(parseVitestOracleResults('not json')).toEqual([]);
    expect(parseVitestOracleResults(JSON.stringify({ testResults: [{ name: 'hook.test.ts', status: 'failed',
      assertionResults: [{ fullName: 'passed before hook error', status: 'passed' }],
    }] }))).toEqual([
      { name: 'passed before hook error', file: 'hook.test.ts', passed: true },
      { name: '', file: 'hook.test.ts', passed: false, executed: false },
    ]);
  });

  it('cloneSubstrate runs git clone then checkout --detach at the pinned commit', async () => {
    const { config, execs } = cfg();
    const p = createGymRunnerPorts(config);
    await p.cloneSubstrate({ source: '/repos/sub', commit: '0123456789abcdef0123456789abcdef01234567', destDir: '/c/gymx' });
    expect(execs[0]).toContain('clone');
    expect(execs[1]).toEqual(['git', '-C', '/c/gymx', 'checkout', '--detach', '0123456789abcdef0123456789abcdef01234567']);
  });

  it('registerThrowawayHarness POSTs the slug + path to /api/harness/projects', async () => {
    const { config, reqs } = cfg();
    const p = createGymRunnerPorts(config);
    await p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' });
    expect(reqs[0].url).toBe('http://127.0.0.1:3971/api/harness/projects');
    expect(JSON.parse(reqs[0].init.body as string)).toEqual({ slug: 'gymx', path: '/c/gymx' });
  });

  it('registerThrowawayHarness throws (fail-loud) when scaffold failed even on HTTP 200', async () => {
    // The /api/harness/projects route swallows a scaffoldHarnessSchema() failure:
    // it returns HTTP 200 / ok:true with provisioning:{ok:false,error}. If the port
    // ignores `provisioning`, the per-harness `harness_features` VIEW is never created
    // and the worker's `UPDATE harness_features` later 42P01s deep in the pipeline.
    // The port MUST surface the scaffold error at registration time.
    const { config } = cfg({
      fetchFn: (async (url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        text: async () => 'unused',
        json: async () => ({
          ok: true,
          project: { slug: 'gymx', path: '/c/gymx' },
          provisioning: { ok: false, error: 'relation "harness_shared.harness_features_consolidated" does not exist' },
        }),
      })) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).rejects.toThrow(/scaffold|provisioning|harness_features_consolidated/);
  });

  it('registerThrowawayHarness succeeds when provisioning.ok is true (or absent)', async () => {
    // ok:true + provisioning.ok:true → no throw (the default cfg fake omits provisioning,
    // which must also be treated as success so non-scaffold registration paths still work).
    const { config } = cfg();
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
  });

  it('registerThrowawayHarness (WI-2604): a 409 for the SAME slug at the SAME clone path is idempotent (no throw) — a leftover/replayed throwaway harness', async () => {
    // gymRunIdentity derives a DETERMINISTIC slug from (task×variant×cycle×repeat) so a
    // DBOS replay / re-run of the same key intentionally re-registers the same slug.
    // Nothing tears the project entry down after a successful run, so this 409 is the
    // COMMON case, not an error — it must resolve, never throw.
    const { config, reqs } = cfg({
      fetchFn: (async (url: string, init?: RequestInit) => {
        reqs.push({ url, init: init ?? {} });
        if (init?.method === 'POST') {
          return { ok: false, status: 409, text: async () => '{"error":"slug already exists"}' } as unknown as Response;
        }
        // The idempotency-check GET
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ slug: 'gymx', path: '/c/gymx' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
    expect(reqs.some((r) => r.init.method === undefined && r.url.endsWith('/api/harness/projects'))).toBe(true);
  });

  it('registerThrowawayHarness (WI-2604): a 409 for the SAME slug at a DIFFERENT path still throws (a real collision, not a replay)', async () => {
    const { config } = cfg({
      fetchFn: (async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return { ok: false, status: 409, text: async () => '{"error":"slug already exists"}' } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ slug: 'gymx', path: '/some/other/unrelated/path' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).rejects.toThrow(/409|collision/);
  });

  it('registerThrowawayHarness (EI-7196): a 409 for the SAME slug under a DIFFERENT scratch root but SAME clone-dir basename is idempotent (no throw)', async () => {
    // The autoloop clones under a FRESH `mkdtemp` scratch root every fire, so the absolute
    // clonePath legitimately changes run-to-run (/tmp/gym-loop-AAA/<slug> → …-BBB/<slug>)
    // even though the deterministic slug is stable and the registry still holds the PRIOR
    // run's path. WI-2604's strict full-path equality never matched this real replay and
    // threw on every subsequent fire — the CHRONIC red. The clone dir is always named after
    // the slug, so a basename match recognizes the same throwaway under any scratch root.
    const { config, reqs } = cfg({
      fetchFn: (async (url: string, init?: RequestInit) => {
        reqs.push({ url, init: init ?? {} });
        if (init?.method === 'POST') {
          return { ok: false, status: 409, text: async () => '{"error":"slug already exists"}' } as unknown as Response;
        }
        // The registry still holds the PRIOR fire's path — a DIFFERENT scratch root, same basename.
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [{ slug: 'gymx', path: '/tmp/gym-loop-AAA/gymx' }] }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.registerThrowawayHarness({ slug: 'gymx', clonePath: '/tmp/gym-loop-BBB/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
    expect(reqs.some((r) => r.init.method === undefined && r.url.endsWith('/api/harness/projects'))).toBe(true);
  });

  it('startPipeline hits the admin route with the superuser bearer + returns the workflow id', async () => {
    const { config, reqs } = cfg();
    const p = createGymRunnerPorts(config);
    const out = await p.startPipeline({ slug: 'gymx', featureId: 'F-GYM-1', workspaceId: 'gym-ws' });
    expect(reqs[0].url).toContain('/api/admin/dbos/pipeline/start');
    expect(reqs[0].url).toContain('superuser=1');
    expect((reqs[0].init.headers as Record<string, string>).authorization).toBe('Bearer sekret-token-1234567890');
    expect(JSON.parse(reqs[0].init.body as string)).toEqual({ harnessSlug: 'gymx', featureId: 'F-GYM-1' });
    expect(out.workflowID).toBe('pipeline:gymx:F-GYM-1:e0');
  });

  it('teardownHarness (EI-484) also DELETEs the throwaway harness project registration, not just the schema/clone', async () => {
    // Without this, /api/harness/projects keeps the entry after teardown drops the
    // schema — the NEXT replay of this deterministic slug then basename-matches the
    // stale registration (WI-2604/EI-7196's 409 idempotency check) and skips real
    // re-registration, so the pipeline 42P01s against the schema this call just
    // dropped (the follow-up edge EI-7196's resolution flagged as still-open).
    const { config, reqs } = cfg({ gymSql: fakeSql() });
    const p = createGymRunnerPorts(config);
    await p.teardownHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' });
    const del = reqs.find((r) => r.init.method === 'DELETE');
    expect(del?.url).toBe('http://127.0.0.1:3971/api/harness/projects/gymx');
  });

  it('teardownHarness never throws even when the DELETE fails (best-effort cleanup)', async () => {
    const { config } = cfg({
      gymSql: fakeSql(),
      fetchFn: (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
      rm: async () => { throw new Error('rm failed'); },
    });
    const p = createGymRunnerPorts(config);
    await expect(
      p.teardownHarness({ slug: 'gymx', clonePath: '/c/gymx', workspaceId: 'gym-ws' }),
    ).resolves.toBeUndefined();
  });

  it('now + sleep work', async () => {
    const p = createGymRunnerPorts(cfg().config);
    expect(typeof p.now()).toBe('number');
    await expect(p.sleep(1)).resolves.toBeUndefined();
  });
});
