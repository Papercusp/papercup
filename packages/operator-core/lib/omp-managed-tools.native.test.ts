/** Installed OMP native-tool controls, with deterministic local inference. */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createOmpNativeHomes } from '../test/omp-native-home';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { nativeToolInventory } from '../../../libs/papercusp/packages/orchestrator/src/managed-capability-client-inventory';
import { composeOmpCapabilityTools, type CapabilityPolicyRequest } from '@papercusp/orchestrator/managed-capability-policy';
import { roleLaunchArgs, suLaunchArgs, resumeArgsFor } from '../../../apps/operator/scripts/psu-launcher.mjs';

declare module 'vitest' {
  interface TaskMeta {
    nativeToolSurface?: unknown;
  }
}

const canary = 'mcp__managed_surface_canary';
const homes = createOmpNativeHomes();
afterAll(() => homes.dispose());

type NativeCensusDiagnostic = {
  nativeFilesBefore: string[]; nativeFilesAfter: string[]; [key: string]: unknown;
};

function captureSurface(noTools: boolean | readonly string[], diagnostics: NativeCensusDiagnostic[]) {
  const omp = wellKnownBackendBin('omp') ?? resolveOnPath('omp');
  if (!omp) throw new Error('Installed OMP is required for native-tool removal evidence');
  const home = homes.allocate();
  const resultPath = join(home, 'census.json');
  const phasesPath = join(home, 'phases.ndjson');
  const nativeFilesBefore = homes.nativeFiles();
  const extensionPath = join(home, 'census.ts');
  // Reuse the installed-runtime provider/extension boundary exercised by the
  // maintained omp-client-uds-roundtrip integration suite. No provider traffic.
  writeFileSync(extensionPath, `
import { writeFileSync } from 'node:fs';
export default function(pi) {
  const phase = name => writeFileSync(process.env.PAPERCUSP_NATIVE_TOOL_PHASE_FILE,
    JSON.stringify({ name, at: Date.now() }) + '\\n', { flag: 'a' });
  phase('extension-entry');
  let calls = 0;
  let turns = 0;
  pi.registerTool({ name: '${canary}', label: 'Managed canary',
    description: 'Local extension canary for tool exposure; not a real Papercusp operation.',
    parameters: pi.zod.object({}), approval: 'read',
    mcpServerName: 'managed-surface', mcpToolName: 'canary',
    async execute() { calls++; return { content: [{ type: 'text', text: 'managed-canary-ok' }] }; }
  });
  pi.registerProvider('surface-fixture', {
    api: 'surface-fixture-api', apiKey: 'local-fixture-only', baseUrl: 'http://unused.invalid',
    models: [{ id: 'proof', name: 'Local surface proof', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context) {
      phase('provider-stream');
      if (++turns > 2) throw new Error('Unexpected inference turn');
      const names = (context.tools ?? []).map(tool => tool.name);
      writeFileSync(process.env.PAPERCUSP_NATIVE_TOOL_CENSUS_FILE, JSON.stringify({ names, calls, turns,
        descriptions: (context.tools ?? []).filter(tool => ['eval', 'hub'].includes(tool.name))
          .map(tool => ({ name: tool.name, description: String(tool.description ?? '').slice(0, 3500) })) }));
      const tool = turns === 1;
      const content = tool
        ? [{ type: 'toolCall', id: 'native-canary', name: '${canary}', arguments: {} }]
        : [{ type: 'text', text: 'Tool census complete.' }];
      const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: tool ? 'toolUse' : 'stop', timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'start', partial: message };
        if (tool) yield { type: 'toolcall_end', contentIndex: 0, toolCall: content[0], partial: message };
        yield { type: 'done', reason: message.stopReason, message };
      }, result: async () => message };
    }
  });
}
`, { mode: 0o600 });
  try {
    const startedAt = Date.now();
    const result = spawnSync(omp, ['--print', '--mode', 'json', '--no-session', '--no-title',
      '--no-extensions', '--no-skills', '--no-rules', '--extension', extensionPath,
      '--model', 'surface-fixture/proof', '--thinking', 'off', '--auto-approve',
      ...(Array.isArray(noTools) ? noTools : noTools ? ['--no-tools'] : []), 'Run the local tool-surface census.'], {
      cwd: home, encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
        PI_CODING_AGENT_DIR: home, PI_CONFIG_DIR: home, PI_DEBUG_STARTUP: '1',
        PAPERCUSP_NATIVE_TOOL_CENSUS_FILE: resultPath, PAPERCUSP_NATIVE_TOOL_PHASE_FILE: phasesPath },
    });
    // Retain startup and command evidence even when the first census fails.
    const diagnostic = { selection: noTools, startedAt, elapsedMs: Date.now() - startedAt,
      status: result.status, signal: result.signal, error: result.error?.message ?? null,
      phases: existsSync(phasesPath) ? readFileSync(phasesPath, 'utf8') : null,
      nativeFilesBefore, nativeFilesAfter: homes.nativeFiles(),
      startupMarkers: result.stderr.split('\n').filter(line => line.startsWith('[startup] ')),
      stdoutTail: result.stdout.slice(-1500), stderrTail: result.stderr.slice(-1500) };
    diagnostics.push(diagnostic);
    console.info('OMP_NATIVE_CENSUS_COMMAND ' + JSON.stringify(diagnostic));
    expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout.slice(-1500)}`).toBe(0);
    const census = JSON.parse(readFileSync(resultPath, 'utf8')) as {
      names: string[]; calls: number; turns: number;
      descriptions: { name: string; description: string }[];
    };
    return { version: execFileSync(omp, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), ...census };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('OMP managed replacement installed-client census', () => {
  const admitted: CapabilityPolicyRequest = {
    client: 'omp', surface: 'launch', clientVersions: { omp: '18.0.3' },
    ompNativeTools: ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'task', 'todo', 'web_search'],
    readiness: [{ family: 'shell-ssh-interpreters', cutoverReady: true, openGapIds: [] }],
    cutoverStaging: { 'shell-ssh-interpreters': 'full' },
    adoption: [{ client: 'omp', family: 'shell-ssh-interpreters',
      managedPathProven: true, nativeBypassRefused: true, atClientVersion: '18.0.3' }],
    matrix: [{ client: 'omp', family: 'shell-ssh-interpreters',
      allScenariosPassed: true, declaredScenarioCount: 7, unmet: [] }],
  };

  it('applies the shared restriction on su, role, fleet and resume without losing the managed canary', ({ task }) => {
    const diagnostics: NativeCensusDiagnostic[] = [];
    task.meta.nativeToolSurface = { diagnostics };
    // Explicit operator-selected native mode is representable by --tools.
    // Default code mode is measured separately and must remain retained.
    const baseline = captureSurface(['--tools', admitted.ompNativeTools!.join(',')], diagnostics);
    const observations: { routes: string[]; argv: string[]; names: string[]; calls: number; version: string }[] = [];
    task.meta.nativeToolSurface = { baseline, observations, diagnostics, controlVersion: admitted.clientVersions!.omp };
    const toolSelection = (argv: (string | undefined)[]) => {
      const index = argv.indexOf('--tools');
      expect(index, JSON.stringify(argv)).toBeGreaterThanOrEqual(0);
      const selected = argv.slice(index, index + 2);
      expect(selected).not.toContain(undefined);
      return selected.filter((arg): arg is string => arg !== undefined);
    };
    const routes = {
      su: toolSelection(suLaunchArgs('omp', { capabilityPolicy: admitted }).args),
      role: toolSelection(roleLaunchArgs('omp', { capabilityPolicy: admitted }).args),
      fleet: composeOmpCapabilityTools([], admitted),
      resume: toolSelection(resumeArgsFor({ agent: 'omp' }, { capabilityPolicy: admitted }).args),
      wake: composeOmpCapabilityTools([], { ...admitted, surface: 'wake' }),
    };
    // The route builders must deliver the same cut. Probe each DISTINCT native
    // selection once, retaining partial observations before any assertion.
    for (const [route, argv] of Object.entries(routes)) {
      const prior = observations.find(row => JSON.stringify(row.argv) === JSON.stringify(argv));
      if (prior) prior.routes.push(route);
      else observations.push({ routes: [route], argv, ...captureSurface(argv, diagnostics) });
    }
    expect(baseline.names).toContain('bash');
    for (const result of observations) {
      expect(result.version).toBe(baseline.version);
      expect(result.names).not.toContain('bash');
      expect(result.calls).toBe(1);
      expect(result.names.filter(name => name !== canary).sort())
        .toEqual(baseline.names.filter(name => name !== 'bash' && name !== canary).sort());
    }
    const defaultSurface = captureSurface(false, diagnostics);
    const defaultPolicy = { ...admitted, ompNativeTools: defaultSurface.names.filter(name => name !== canary) };
    expect(defaultSurface.names).toEqual(expect.arrayContaining(['eval', 'hub']));
    expect(composeOmpCapabilityTools([], defaultPolicy)).toEqual([]);
    // Version drift must keep the native surface, independently of adoption's pin.
    const drift = composeOmpCapabilityTools([], { ...admitted, clientVersions: { omp: '18.0.4' },
      adoption: admitted.adoption!.map(row => ({ ...row, atClientVersion: undefined })) });
    expect(drift).toEqual([]);
    expect(defaultSurface.names).toContain('bash');
    const extracted = diagnostics[0]!.nativeFilesAfter;
    expect(extracted.some(path => path.endsWith('.node')), 'Installed OMP must populate the owned cache').toBe(true);
    for (const sample of diagnostics.slice(1)) {
      expect(sample.nativeFilesBefore).toEqual(extracted);
      expect(sample.nativeFilesAfter).toEqual(extracted);
    }
  }, 180_000);

  it('removes built-in execution tools while an extension tool still executes', ({ task }) => {
    const diagnostics: NativeCensusDiagnostic[] = [];
    task.meta.nativeToolSurface = { diagnostics };
    const baseline = captureSurface(false, diagnostics);
    const restricted = captureSurface(true, diagnostics);
    const inventory = nativeToolInventory({ client: 'omp', clientVersion: baseline.version,
      nativeNames: [...baseline.names, ...restricted.names], managedNames: [canary] });
    task.meta.nativeToolSurface = { baseline, restricted, inventory, diagnostics };
    expect(inventory.rows.every(row => row.gap === null || row.gap === 'client-version-drift' ||
      row.gap === 'native-parity-unverified')).toBe(true);
    expect(baseline.descriptions.find(row => row.name === 'eval')?.description).toMatch(/persistent kernel/i);
    const hubDescription = baseline.descriptions.find(row => row.name === 'hub')?.description;
    expect(hubDescription).toMatch(/coordination|peer messaging/i);
    expect(hubDescription).toMatch(/background.job/i);
    expect(hubDescription).toMatch(/process/i);
    // OMP can defer an MCP extension's schema from context.tools; actual
    // execution is the positive control for that interface.
    expect(baseline.calls).toBe(1);
    expect(restricted.calls).toBe(1);
    expect(baseline.turns).toBe(2);
    expect(restricted.turns).toBe(2);
    for (const name of ['bash', 'read', 'edit', 'write']) {
      expect(baseline.names).toContain(name);
      expect(restricted.names).not.toContain(name);
    }
  }, 60_000);
});
