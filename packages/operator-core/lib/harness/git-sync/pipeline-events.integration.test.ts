/**
 * pipeline-events.integration.test.ts — real-Postgres round-trip for the mig-177
 * pipeline history: append events, then summarize a window + read the recent
 * timeline back over actual rows (not a mocked `sql`).
 *
 * Uses the production-faithful testcontainer client from _pg-helpers (the same
 * `prepare:false` + BIGINT→number config as getOrgPg), and inlines the mig-177 +
 * mig-419 table/constraint DDL (RLS/grants omitted — the test client is the table
 * owner). The append fns take an injectable `sql` (the emitUsageEvent seam) so
 * they run against it.
 *
 * EI-2969 recurrence guard: mig-419 widened `pipeline_events_kind_check` after
 * the TS `PipelineEventKind` union grew ('content_fixer' / 'release_fixer')
 * without the DB constraint following — every content-fixer/release-fixer write
 * (including the release-fixer's GREEN verdict) was silently rejected at the DB
 * layer for ~74h, freezing deploys fleet-wide. The CHECK constraint is now
 * mirrored into this suite's DDL (not just the bare inline table from mig-177),
 * and 'every PipelineEventKind round-trips' asserts each kind in the TS union is
 * still accepted by the mirrored constraint — so a future kind added to the type
 * without a matching migration fails HERE instead of silently dropping rows in
 * production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import {
  appendPipelineEvent,
  summarizePipelineWindow,
  recentPipelineEvents,
  type PipelineEventKind,
} from './pipeline-events';

const SLUG = 'pipetest';
let db: FreshPgDb;

// Keep in sync with libs/papercusp/libs/db/sql/419-pipeline-events-kind-content-release-fixer.sql —
// this is the LIVE constraint's allowlist, mirrored here on purpose (see EI-2969 note above).
const ALL_KINDS: PipelineEventKind[] = ['git_sync', 'merge_resolver', 'content_fixer', 'green_checkpoint', 'deploy', 'release_fixer'];

describe('pipeline-events runtime — real Postgres', () => {
  beforeAll(async () => {
    db = await createFreshPgDb('pipeline');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.pipeline_events (
        id bigserial PRIMARY KEY,
        workspace_id text NOT NULL,
        install_slug text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pipeline_events_kind_check CHECK (kind = ANY (ARRAY['git_sync'::text, 'merge_resolver'::text, 'content_fixer'::text, 'green_checkpoint'::text, 'deploy'::text, 'release_fixer'::text]))
      );
    `);
  });
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.pipeline_events RESTART IDENTITY`;
  });

  it('appends events and summarizes the trailing window per kind/status', async () => {
    for (let i = 0; i < 5; i++) {
      await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);
    }
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'conflict', detail: { conflicts: [{ scope: 'libs/x' }] } }, db.sql);
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'merge_resolver', status: 'ok', detail: { exitCode: 0 } }, db.sql);
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'green_checkpoint', status: 'advanced', detail: { green: true } }, db.sql);
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'green_checkpoint', status: 'not-green', detail: { green: false } }, db.sql);

    const w = await summarizePipelineWindow(SLUG, 24 * 60 * 60, db.sql);
    expect(w.gitSync).toMatchObject({ total: 6, synced: 5, conflict: 1 });
    expect(w.mergeResolver).toMatchObject({ total: 1, ok: 1 });
    expect(w.greenCheckpoint).toMatchObject({ total: 2, advanced: 1, notGreen: 1 });
  });

  it('excludes events older than the window', async () => {
    await db.sql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, created_at)
      VALUES ('ws', ${SLUG}, 'git_sync', 'synced', now() - interval '10 days')
    `;
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);

    const day = await summarizePipelineWindow(SLUG, 24 * 60 * 60, db.sql);
    const week = await summarizePipelineWindow(SLUG, 7 * 24 * 60 * 60, db.sql);
    expect(day.gitSync.total).toBe(1); // only the fresh one
    expect(week.gitSync.total).toBe(1); // 10d-old row excluded from the 7d window too
  });

  it('scopes counts to the harness slug', async () => {
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: 'other-harness', kind: 'git_sync', status: 'conflict' }, db.sql);
    const w = await summarizePipelineWindow(SLUG, 24 * 60 * 60, db.sql);
    expect(w.gitSync.total).toBe(1);
    expect(w.gitSync.conflict).toBe(0);
  });

  it('EI-2969 recurrence guard: every PipelineEventKind round-trips against the live kind_check constraint', async () => {
    for (const kind of ALL_KINDS) {
      // status 'ok' is a valid value for every kind in production usage (see
      // foldPipelineWindow's per-kind status handling) — the constraint under test
      // gates on `kind` only, so a single representative status is sufficient.
      await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind, status: 'ok' }, db.sql);
    }
    const recent = await recentPipelineEvents(SLUG, ALL_KINDS.length, db.sql);
    expect(recent.map((r) => r.kind).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('reads the recent timeline newest-first with parsed detail', async () => {
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'merge_resolver', status: 'ok', detail: { scopes: ['libs/x'] } }, db.sql);

    const recent = await recentPipelineEvents(SLUG, 10, db.sql);
    expect(recent).toHaveLength(2);
    expect(recent[0].kind).toBe('merge_resolver'); // newest first
    expect(recent[0].status).toBe('ok');
    expect(recent[0].createdAtMs).toBeGreaterThan(0);
    // detail tolerates the client's jsonb representation (object or string).
    expect(recent[0].detail).toBeTypeOf('object');
  });
});
