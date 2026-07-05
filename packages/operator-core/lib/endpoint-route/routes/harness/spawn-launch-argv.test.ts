/**
 * spawn-launch-argv.test.ts — unit coverage for `reconstructHiveLaunchArgv`
 * (launch-path-argv-reconstruction WI-1343, extended to the hive/overwatch
 * invoke chokepoint by WI-1347).
 *
 * spawn.ts pulls in the full launch stack (PG, harness-core, harness-launch,
 * plugin lifecycle, …) at import time, so every non-trivial import is mocked
 * here — mirrors launch-su.test.ts's approach for the same reason. We only
 * exercise the pure, exported argv-reconstruction helper.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: vi.fn(() => ({ sql: vi.fn() })),
  listUnconsumedEvents: vi.fn(async () => []),
  consumeEvents: vi.fn(async () => {}),
}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
}));
vi.mock('../../../harness-core', () => ({
  resolveProject: vi.fn(),
  resolvePhasedProject: vi.fn(),
  harnessDir: vi.fn(() => '/tmp/harness'),
}));
vi.mock('../../../harness-phases', () => ({
  phasePhaseLabel: vi.fn(),
}));
vi.mock('../../../superuser-token', () => ({
  SUPERUSER_TOKEN_PATH: '/tmp/token',
}));
vi.mock('../../../harness-launch', () => ({
  launchRun: vi.fn(),
}));
vi.mock('../../../plugin-host-runtime', () => ({
  firePluginLifecycle: vi.fn(async () => {}),
}));
vi.mock('../../../events/pipeline-events', () => ({
  emitPipelineEvent: vi.fn(),
}));
vi.mock('../../../adv-sessions', () => ({
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: vi.fn((spec: unknown) => spec),
}));
vi.mock('../../../operator-api-base', () => ({
  operatorApiBase: vi.fn(() => 'http://localhost:3070'),
}));
vi.mock('../../../harness-invoke-once', () => ({
  resolveSpawnBackendModel: vi.fn(),
}));
vi.mock('../../../backend-feature-capabilities', () => ({
  backendFeatureGuard: vi.fn(() => ({ supported: true })),
  interactiveBackendFromSpawnBackend: vi.fn((b: string) => b),
}));

import { reconstructHiveLaunchArgv } from './spawn';

describe('reconstructHiveLaunchArgv (WI-1347)', () => {
  it('builds a forensic invoke descriptor for a hive launch', () => {
    expect(
      reconstructHiveLaunchArgv({
        backend: 'claude',
        role: 'engineer',
        harnessSlug: 'papercusp',
        isOverwatchLaunch: false,
      }),
    ).toEqual(['invoke', '--agent=claude', '--role=engineer', '--harness=papercusp', '--kind=hive']);
  });

  it('marks an overwatch launch with --kind=overwatch', () => {
    const argv = reconstructHiveLaunchArgv({
      backend: 'codex',
      role: 'kettle',
      harnessSlug: 'papercusp',
      isOverwatchLaunch: true,
    });
    expect(argv).toContain('--kind=overwatch');
    expect(argv).not.toContain('--kind=hive');
  });

  it('appends --model= only when a modelPin is provided', () => {
    const withPin = reconstructHiveLaunchArgv({
      backend: 'claude',
      role: 'engineer',
      harnessSlug: 'h1',
      isOverwatchLaunch: false,
      modelPin: 'claude-opus',
    });
    expect(withPin).toEqual([
      'invoke', '--agent=claude', '--role=engineer', '--harness=h1', '--kind=hive', '--model=claude-opus',
    ]);

    const withoutPin = reconstructHiveLaunchArgv({
      backend: 'claude',
      role: 'engineer',
      harnessSlug: 'h1',
      isOverwatchLaunch: false,
      modelPin: null,
    });
    expect(withoutPin.some((a) => a.startsWith('--model='))).toBe(false);
  });
});
