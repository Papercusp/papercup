/**
 * EI-20228373335568300 — managed Codex rollouts are the first durable source
 * of the native id, model, and reasoning effort for an adv_sessions row.
 * These tests stay filesystem/pure so they do not depend on a live fleet row;
 * the SQL contract guard below pins the metadata-only repair semantics.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  codexAdvSessionMetadata,
  parseCodexEffectiveConfig,
  ompTranscriptMeta,
} from './session-ingest';

const NATIVE_ID = '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f';

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

async function managedRollout(config: string, name = `rollout-2026-08-12T00-00-00-${NATIVE_ID}.jsonl`) {
  root = await mkdtemp(join(tmpdir(), 'codex-adv-metadata-'));
  const home = join(root, 'su-codex-homes', 'session-15002');
  const day = join(home, 'sessions', '2026', '08', '12');
  await mkdir(day, { recursive: true });
  await writeFile(join(home, 'config.toml'), config);
  const filePath = join(day, name);
  await writeFile(filePath, '');
  return filePath;
}

describe('parseCodexEffectiveConfig', () => {
  it('reads the root model and reasoning effort, not profile/table values', () => {
    expect(parseCodexEffectiveConfig([
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      '[profiles.fast]',
      'model = "gpt-5.5"',
      'model_reasoning_effort = "low"',
    ].join('\n'))).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh' });
  });

  it('fails soft when Codex has not written either setting yet', () => {
    expect(parseCodexEffectiveConfig('[features]\nmemories = false')).toEqual({ model: null, effort: null });
  });
});

describe('codexAdvSessionMetadata', () => {
  it('maps a paused/no-new-bytes rollout to its adv row and effective config', async () => {
    const filePath = await managedRollout([
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      '[features]',
      'memories = false',
    ].join('\n'));

    // The empty file models a paused session: discovery has a durable rollout
    // path, but there is no late transcript turn to advance byte_offset.
    expect(codexAdvSessionMetadata(filePath)).toEqual({
      advSessionId: 15002,
      sessionId: NATIVE_ID,
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
  });

  it('still repairs the native id when the reaper removed config.toml', async () => {
    const filePath = await managedRollout('');
    await rm(join(root!, 'su-codex-homes', 'session-15002', 'config.toml'));

    expect(codexAdvSessionMetadata(filePath)).toEqual({
      advSessionId: 15002,
      sessionId: NATIVE_ID,
      model: null,
      effort: null,
    });
  });

  it('preserves an explicit native identity and reads fresh config on metadata-only repair', async () => {
    const filePath = await managedRollout('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "xhigh"');
    const resolvedId = '019f4fa9-4a09-78c0-8a35-000000000002';
    expect(codexAdvSessionMetadata(filePath, resolvedId)).toEqual({
      advSessionId: 15002, sessionId: resolvedId, model: 'gpt-5.6-sol', effort: 'xhigh',
    });

    await writeFile(join(root!, 'su-codex-homes', 'session-15002', 'config.toml'),
      'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"');
    expect(codexAdvSessionMetadata(filePath, resolvedId)).toEqual({
      advSessionId: 15002, sessionId: resolvedId, model: 'gpt-6.1-sol', effort: 'high',
    });
  });

  it('does not attribute shared or temporary homes to adv_sessions', async () => {
    const filePath = await managedRollout('model = "gpt-5.6-sol"');
    expect(codexAdvSessionMetadata(filePath.replace('/su-codex-homes/session-15002/', '/.codex/'))).toBeNull();
    expect(codexAdvSessionMetadata(filePath.replace('/su-codex-homes/session-15002/', '/su-codex-homes/session-t-1/'))).toBeNull();
    expect(codexAdvSessionMetadata(filePath.replace(NATIVE_ID, 'not-a-native-id'))).toBeNull();
  });
});

describe('Codex adv-session backfill wiring', () => {
  const source = readFileSync(new URL('./session-ingest.ts', import.meta.url), 'utf8');

  it('collects metadata before the no-new-bytes short circuit', () => {
    const start = source.indexOf('const codexMetadataBackfill');
    const end = source.indexOf('await backfillSessionOwners', start);
    const block = source.slice(start, end);
    expect(block.indexOf('codexAdvSessionMetadata')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('codexAdvSessionMetadata')).toBeLessThan(block.indexOf('cand.size <= st.byte_offset'));
  });

  it('updates only identity/launch metadata and never lifecycle timestamps', () => {
    const start = source.indexOf('async function backfillCodexAdvSessions');
    const end = source.indexOf('/**\n * Rows re-classified per sweep.', start);
    const block = source.slice(start, end);
    expect(block).toContain('UPDATE harness_shared.adv_sessions');
    expect(block).toContain("sessions.workspace_id = ${activeWorkspaceId()}");
    expect(block).not.toMatch(/\bended_at\s*=/);
    expect(block).not.toMatch(/\bstarted_at\s*=/);
    expect(block).not.toMatch(/\bexit_code\s*=/);
  });
});

describe('OMP transcript metadata', () => {
  it('extracts the native thread id and managed adv-session id', () => {
    expect(ompTranscriptMeta(
      '/home/test/.papercusp/su-omp-homes/session-14830/agent/sessions/-repo/2026-08-11T19-31-28-125Z_019ff24e-f2fd-7000-a2ff-36c02fc83c32.jsonl',
    )).toEqual({
      sessionId: '019ff24e-f2fd-7000-a2ff-36c02fc83c32',
      owner: null,
      advSessionId: 14830,
    });
  });

  it('keeps shared OMP transcripts unowned', () => {
    expect(ompTranscriptMeta(
      '/home/test/.omp/agent/sessions/-repo/2026-08-11T19-31-28-125Z_thread-shared.jsonl',
    )).toEqual({
      sessionId: 'thread-shared',
      owner: null,
      advSessionId: null,
    });
  });

  it('rejects malformed managed-home ids instead of inventing an owner join', () => {
    expect(ompTranscriptMeta(
      '/home/test/.papercusp/su-omp-homes/session-not-a-number/agent/sessions/-repo/t_thread.jsonl',
    ).advSessionId).toBeNull();
  });
});

describe('OMP owner backfill wiring', () => {
  const source = readFileSync(new URL('./session-ingest.ts', import.meta.url), 'utf8');

  it('loads managed owners once before the per-file loop and feeds resolved owners to rows', () => {
    const adapterSweep = source.indexOf('for (const adapter of FILE_ADAPTERS)');
    const ownerLoad = source.indexOf('loadOmpSessionOwners(sql, managedIds)', adapterSweep);
    const fileLoop = source.indexOf('for (const cand of candidates)', adapterSweep);
    expect(adapterSweep).toBeGreaterThanOrEqual(0);
    expect(ownerLoad).toBeGreaterThan(adapterSweep);
    expect(ownerLoad).toBeLessThan(fileLoop);
    expect(source).toContain("AND mode = 'omp'");
    expect(source).toContain('ownerBackfill.set(meta.sessionId, owner)');
    expect(source).toContain('owner,\n            harness_slug: null');
  });
});
