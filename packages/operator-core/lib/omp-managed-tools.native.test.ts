/** Installed OMP native-tool controls, with deterministic local inference. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { nativeToolInventory } from '../../../libs/papercusp/packages/orchestrator/src/managed-capability-client-inventory';

declare module 'vitest' {
  interface TaskMeta {
    nativeToolSurface?: unknown;
  }
}

const canary = 'mcp__managed_surface_canary';

function captureSurface(noTools: boolean) {
  const omp = wellKnownBackendBin('omp') ?? resolveOnPath('omp');
  if (!omp) throw new Error('Installed OMP is required for native-tool removal evidence');
  const home = mkdtempSync(join(tmpdir(), 'omp-managed-surface-'));
  const resultPath = join(home, 'census.json');
  const extensionPath = join(home, 'census.ts');
  // Reuse the installed-runtime provider/extension boundary exercised by the
  // maintained omp-client-uds-roundtrip integration suite. No provider traffic.
  writeFileSync(extensionPath, `
import { writeFileSync } from 'node:fs';
export default function(pi) {
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
    const result = spawnSync(omp, ['--print', '--mode', 'json', '--no-session', '--no-title',
      '--no-extensions', '--no-skills', '--no-rules', '--extension', extensionPath,
      '--model', 'surface-fixture/proof', '--thinking', 'off', '--auto-approve',
      ...(noTools ? ['--no-tools'] : []), 'Run the local tool-surface census.'], {
      cwd: home, encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
        PI_CODING_AGENT_DIR: home, PI_CONFIG_DIR: home,
        PAPERCUSP_NATIVE_TOOL_CENSUS_FILE: resultPath },
    });
    expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout.slice(-1500)}`).toBe(0);
    const census = JSON.parse(readFileSync(resultPath, 'utf8')) as { names: string[]; calls: number; turns: number };
    return { version: execFileSync(omp, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(), ...census };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('OMP managed replacement installed-client census', () => {
  it('removes built-in execution tools while an extension tool still executes', ({ task }) => {
    const baseline = captureSurface(false);
    const restricted = captureSurface(true);
    const inventory = nativeToolInventory({ client: 'omp', clientVersion: baseline.version,
      nativeNames: [...baseline.names, ...restricted.names], managedNames: [canary] });
    task.meta.nativeToolSurface = { baseline, restricted, inventory };
    expect(inventory.rows.every(row => row.gap === null || row.gap === 'client-version-drift' ||
      row.gap === 'native-semantics-unmeasured')).toBe(true);
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
