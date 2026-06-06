import { describe, it, expect } from 'vitest';
import { buildFrameBootstrap, FRAME_BOOTSTRAP_STEPS } from './frame-bootstrap';

const baseEnv = { setup: [], install: [], build: [], test: [], run: [], services: [], ports: [], env: {} };

describe('buildFrameBootstrap', () => {
  it('emits a valid bash header + every step for a full coding frame', () => {
    const { script, steps } = buildFrameBootstrap({
      harnessSlug: 'papercup',
      repoUrl: 'https://github.com/acme/repo.git',
      environment: {
        ...baseEnv,
        setup: ['nvm install 22'],
        install: ['npm ci'],
        build: ['npm run build'],
        services: [{ name: 'redis', command: 'redis-server', port: 6379 }],
        env: { NODE_ENV: 'production' },
      },
      claudeCredentialsRemotePath: '/root/creds.json',
    });
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('Frame for harness: papercup');
    // every section present
    for (const s of FRAME_BOOTSTRAP_STEPS) expect(steps).toContain(s);
    expect(script).toContain('nvm install 22');
    expect(script).toContain('npm ci');
    expect(script).toContain('redis-server');
    expect(script).toContain("export NODE_ENV='production'");
    expect(script).toContain('PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='); // scoped to one harness
  });

  it('repo-less harness omits the repo step', () => {
    const { steps } = buildFrameBootstrap({ harnessSlug: 'research', environment: baseEnv });
    expect(steps).not.toContain('repo');
  });

  it('no credentials → no credentials step', () => {
    const { steps } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv });
    expect(steps).not.toContain('credentials');
  });

  it('embeddedPg:false and orchestratorOnFrame:false drop those sections', () => {
    const { steps, script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      embeddedPg: false,
      orchestratorOnFrame: false,
    });
    expect(steps).not.toContain('embedded-pg');
    expect(steps).not.toContain('orchestrator-loop');
    expect(script).not.toContain('PAPERCUSP_DBOS_ORCHESTRATOR=1');
  });

  it('custom runtimeSetup replaces the default clone+build', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      runtimeSetup: ['curl -fsSL https://bundles.example/runtime.tgz | tar xz -C /opt/papercusp/runtime'],
    });
    expect(script).toContain('bundles.example/runtime.tgz');
    expect(script).not.toContain('git clone --depth 1 https://github.com/Papercusp/papercup.git');
  });

  it('shell-quotes interpolated values (no injection from a slug)', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: "x'; rm -rf /", environment: baseEnv });
    expect(script).toContain(`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='x'\\''; rm -rf /'`);
  });

  it('non-omp backend does not start Meridian', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv, agentBackend: 'claude' });
    expect(script).toContain('backend is not omp');
    expect(script).toContain("AGENT_BACKEND='claude-code'");
  });

  it('exports the instance config via HARNESS_CONFIG_JSON when provided (P-008)', () => {
    const { script } = buildFrameBootstrap({
      harnessSlug: 'h',
      environment: baseEnv,
      instanceConfigJson: '{"phase":"production","maxCostUsd":5}',
    });
    expect(script).toContain(`export HARNESS_CONFIG_JSON='{"phase":"production","maxCostUsd":5}'`);
  });

  it('omits HARNESS_CONFIG_JSON when no instance config', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'h', environment: baseEnv });
    expect(script).not.toContain('HARNESS_CONFIG_JSON');
  });

  it('a control node (Queen) runs the loop UNSCOPED (P-016)', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'queen-h1', environment: baseEnv, controlNode: true });
    expect(script).toContain("PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='*'");
  });

  it('an execution frame scopes the loop to its one harness', () => {
    const { script } = buildFrameBootstrap({ harnessSlug: 'papercup', environment: baseEnv });
    expect(script).toContain("PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES='papercup'");
  });
});
