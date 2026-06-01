import { describe, test, expect } from 'vitest';
import { buildPipelineExtraEnv } from './orchestrator-spawn-env';

describe('buildPipelineExtraEnv — invoke-once spawn env for the durable pipeline', () => {
  test('always sets HARNESS_SLUG to the REGISTRY slug (not the dir basename)', () => {
    // The bug: invoke-once derives the slug from basename(projectDir) when
    // HARNESS_SLUG is unset + the registry curl fails, so a harness whose dir
    // (sheets-clone) differs from its slug (sheets) bootstraps the wrong schema
    // (harness_sheets_clone, which doesn't exist) → empty director output.
    const env = buildPipelineExtraEnv({ harnessSlug: 'sheets' });
    expect(env.HARNESS_SLUG).toBe('sheets');
  });

  test('includes IDEMPOTENCY_KEY when provided', () => {
    const env = buildPipelineExtraEnv({ harnessSlug: 'sheets', idempotencyKey: 'sheets:F-1:worker:t0' });
    expect(env.IDEMPOTENCY_KEY).toBe('sheets:F-1:worker:t0');
    expect(env.HARNESS_SLUG).toBe('sheets');
  });

  test('omits IDEMPOTENCY_KEY when not provided (finalizer curator/documenter)', () => {
    const env = buildPipelineExtraEnv({ harnessSlug: 'sheets' });
    expect('IDEMPOTENCY_KEY' in env).toBe(false);
  });

  test('pins PAPERCUSP_WORKSPACE_ID when provided', () => {
    const env = buildPipelineExtraEnv({ harnessSlug: 'sheets', workspaceId: 'default' });
    expect(env.PAPERCUSP_WORKSPACE_ID).toBe('default');
  });

  test('omits PAPERCUSP_WORKSPACE_ID when not provided', () => {
    const env = buildPipelineExtraEnv({ harnessSlug: 'sheets' });
    expect('PAPERCUSP_WORKSPACE_ID' in env).toBe(false);
  });

  test('all fields together', () => {
    const env = buildPipelineExtraEnv({
      harnessSlug: 'sheets',
      idempotencyKey: 'k',
      workspaceId: 'default',
    });
    expect(env).toEqual({
      HARNESS_SLUG: 'sheets',
      IDEMPOTENCY_KEY: 'k',
      PAPERCUSP_WORKSPACE_ID: 'default',
      // P-040: pipeline spawns route the worker chunk-loop through the PG lock backend.
      PAPERCUSP_CHUNK_LOCK_PG: '1',
    });
  });

  test('always sets PAPERCUSP_CHUNK_LOCK_PG=1 (pipeline spawn → PG lock backend, P-040)', () => {
    expect(buildPipelineExtraEnv({ harnessSlug: 'sheets' }).PAPERCUSP_CHUNK_LOCK_PG).toBe('1');
  });
});
