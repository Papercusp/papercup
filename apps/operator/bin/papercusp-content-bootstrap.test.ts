import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runContentBootstrap,
  WORKSPACE_HOST_CONTENT_BUNDLE,
} from './papercusp-content-bootstrap';
import type { InstallBundleAppOutcome } from '@papercusp/operator-core/lib/cupboard/bundle-app-install-io';

type SuccessfulOutcome = Extract<InstallBundleAppOutcome, { ok: true }>;

const roots: string[] = [];

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-content-bootstrap-'));
  roots.push(root);
  return root;
}

function success(): SuccessfulOutcome {
  return {
    ok: true,
    manifest: { name: 'Papercusp workspace-host content' },
    result: {
      ok: true,
      review: { clean: [], duplicates: [], conflicts: [] },
      blockedByConflicts: false,
      deps: {
        ok: true,
        installed: [],
        stillMissing: { tools: [], packs: [], plugins: [], events: [] },
        advisory: [],
        rounds: 0,
      },
      datatypes: [],
      blueprint: { id: 'base', ok: true },
      blueprints: [{ id: 'base', ok: true }],
      templates: [{ id: 'papercusp-app', ok: true }],
      rubrics: [{ id: 'pot-coordination-health', ok: true }],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('papercusp-content-bootstrap', () => {
  it('pins the official bundle into the persistent state home and defers only rubric seeding', async () => {
    const state = stateRoot();
    const installBundle = vi.fn(async () => {
      expect(process.env.PAPERCUSP_HOME).toBe(join(state, '.papercusp'));
      expect(process.env.PAPERCUSP_PROMPTS_DIR).toBe(
        join(state, '.papercusp', 'blueprints', 'base', 'prompts'),
      );
      expect(process.env.PAPERCUSP_TEMPLATES_DIR).toBe(join(state, '.papercusp', 'templates'));
      expect(process.env.PAPERCUSP_RUBRICS_DIR).toBe(join(state, '.papercusp', 'rubrics'));
      return success();
    });
    const stdout = vi.fn();

    expect(
      await runContentBootstrap(
        ['--state-root', state],
        { installBundle, stdout, stderr: vi.fn() },
      ),
    ).toBe(0);
    expect(installBundle).toHaveBeenCalledWith(WORKSPACE_HOST_CONTENT_BUNDLE, {
      workspaceId: 'workspace-host',
      offlineContentOnly: true,
      deferRubricSeed: true,
    });
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
      ok: true,
      contentHome: join(state, '.papercusp'),
      installed: { blueprints: 1, templates: 1, rubrics: 1 },
      rubricSeed: 'deferred-to-operator-startup',
    });
  });

  it('rejects unsafe argv before installing and reports an incomplete bundle as failure', async () => {
    const installBundle = vi.fn().mockResolvedValue({
      ...success(),
      result: { ...success().result, ok: false },
    });
    const stderr = vi.fn();
    expect(await runContentBootstrap(['--state-root', 'relative'], { installBundle, stderr })).toBe(2);
    expect(installBundle).not.toHaveBeenCalled();

    const state = stateRoot();
    expect(await runContentBootstrap(['--state-root', state], { installBundle, stderr })).toBe(1);
    expect(stderr.mock.calls.at(-1)?.[0]).toContain('content bundle incomplete');
  });

  it('keeps --help side-effect-free', async () => {
    const installBundle = vi.fn();
    const stdout = vi.fn();
    expect(await runContentBootstrap(['--help'], { installBundle, stdout })).toBe(0);
    expect(installBundle).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(
      'Usage: papercusp-content-bootstrap --state-root <absolute-directory>',
    );
  });
});
