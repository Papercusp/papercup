import { describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '@papercusp/orchestrator';
import {
  resolveWorkerParityRoute,
  runWorkerParityCohort,
  workerParityArmConfig,
  workerParityArmEnv,
  workerParityPrompt,
  type GatewayEnvResolver,
} from './worker-parity-runner';

const gatewayResolver = (): GatewayEnvResolver => vi.fn(async (
  input: Parameters<GatewayEnvResolver>[0],
): Promise<Record<string, string>> => {
  if (input.backend === 'omp') {
    return {
      PAPERCUSP_OMP_MODEL_SELECTOR: `papercusp-gateway/${input.model}`,
      PAPERCUSP_OMP_MODELS_YML: [
        '# BEGIN PAPERCUSP_OMP_GATEWAY',
        'providers:',
        '  papercusp-gateway:',
        '    baseUrl: "http://127.0.0.1:8788"',
      ].join('\n'),
    };
  }
  return {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
    ANTHROPIC_AUTH_TOKEN: 'papercusp-gateway',
    PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
  };
});

describe('resolveWorkerParityRoute — D-027 non-generation proof', () => {
  it('canonicalizes a subscription alias and proves both local gateway legs', async () => {
    const resolveGatewayEnv = gatewayResolver();
    const route = await resolveWorkerParityRoute({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      ownerId: 'su-1',
      model: 'claude/claude-haiku-4-5',
      resolveGatewayEnv,
    });

    expect(route).toMatchObject({
      schemaVersion: 'worker-parity-route-v1',
      model: 'claude-haiku-4-5',
      loopProvider: 'gateway-anthropic',
      account: 'auto',
      proof: {
        ompSelector: 'papercusp-gateway/claude-haiku-4-5',
        ompGatewayBaseUrl: 'http://127.0.0.1:8788/',
        loopGatewayBaseUrl: 'http://127.0.0.1:8788/',
      },
    });
    expect(resolveGatewayEnv).toHaveBeenCalledTimes(2);
    expect(resolveGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'omp', account: 'auto', model: 'claude-haiku-4-5', role: 'worker',
    }));
    expect(resolveGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'claude-code', account: 'auto', model: 'claude-haiku-4-5', role: 'worker',
    }));
  });

  it('rejects provider-qualified API-key models before resolving any route', async () => {
    const resolveGatewayEnv = gatewayResolver();
    await expect(resolveWorkerParityRoute({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      model: 'anthropic/claude-haiku-4-5',
      resolveGatewayEnv,
    })).rejects.toThrow(/forbids direct-provider model/);
    expect(resolveGatewayEnv).not.toHaveBeenCalled();
  });

  it('fails closed when either route is not the local managed gateway', async () => {
    const resolveGatewayEnv: GatewayEnvResolver = async (input): Promise<Record<string, string>> => input.backend === 'omp'
      ? {
          PAPERCUSP_OMP_MODEL_SELECTOR: 'papercusp-gateway/claude-haiku-4-5',
          PAPERCUSP_OMP_MODELS_YML: '# BEGIN PAPERCUSP_OMP_GATEWAY\n    baseUrl: "https://api.anthropic.com"',
        }
      : {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
          ANTHROPIC_AUTH_TOKEN: 'papercusp-gateway',
          PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
        };
    await expect(resolveWorkerParityRoute({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      model: 'claude-haiku-4-5',
      resolveGatewayEnv,
    })).rejects.toThrow(/must resolve the local Papercusp gateway/);
  });
});

describe('paired invocation contract', () => {
  it('changes only the worker engine while pinning the identical canonical model', () => {
    const base = {
      aiBackend: {
        default: { extraArgs: ['--existing'] },
        roles: { worker: { extraArgs: ['--worker-existing'], timeout: 9 } },
      },
      dept: 'engineering',
    } as HarnessConfig;
    const omp = workerParityArmConfig(base, 'omp', 'claude-haiku-4-5') as any;
    const loop = workerParityArmConfig(base, 'loop', 'claude-haiku-4-5') as any;
    expect(omp.aiBackend.roles.worker).toMatchObject({
      engine: 'subprocess', agentCmd: 'omp -p', model: 'claude-haiku-4-5', timeout: 9,
    });
    expect(loop.aiBackend.roles.worker).toMatchObject({
      engine: 'loop', agentCmd: 'omp -p', model: 'claude-haiku-4-5', timeout: 9,
    });
    expect(loop.aiBackend.default.extraArgs).toEqual(['--existing']);
    expect(loop.dept).toBe('engineering');
  });

  it('normalizes the subprocess-only sandbox out of the engine comparison', () => {
    expect(workerParityArmEnv({ PAPERCUSP_OMP_MODEL_SELECTOR: 'gateway/model' })).toEqual({
      PAPERCUSP_OMP_MODEL_SELECTOR: 'gateway/model',
      PAPERCUSP_FLEET_SANDBOX: '0',
    });
  });

  it('runs every pair through both arms with byte-identical prompts and deterministic run ids', async () => {
    const route = await resolveWorkerParityRoute({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      model: 'claude-haiku-4-5',
      resolveGatewayEnv: gatewayResolver(),
    });
    const seen: any[] = [];
    const result = await runWorkerParityCohort({
      route,
      cohortId: 'd027-test',
      pairs: 2,
      runArm: async (arm) => {
        seen.push(arm);
        return { ...arm, exitCode: 0, output: 'ok', durationMs: 1 };
      },
    });

    expect(result.completedPairs).toBe(2);
    expect(seen.map((entry) => entry.runId)).toEqual([
      'worker-parity-d027-test-01-omp',
      'worker-parity-d027-test-01-loop',
      'worker-parity-d027-test-02-omp',
      'worker-parity-d027-test-02-loop',
    ]);
    expect(seen[0].prompt).toBe(seen[1].prompt);
    expect(seen[2].prompt).toBe(seen[3].prompt);
    expect(seen[0].prompt).not.toBe(seen[2].prompt);
    expect(seen.every((entry) => entry.model === 'claude-haiku-4-5')).toBe(true);
  });

  it('builds a read-only, one-tool prompt', () => {
    expect(workerParityPrompt(7)).toContain('capability:read exactly once');
    expect(workerParityPrompt(7)).toContain('PARITY_OK_07');
    expect(workerParityPrompt(7)).toContain('do not modify anything');
  });
});
