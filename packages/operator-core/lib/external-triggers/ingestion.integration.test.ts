import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { isCompilableSchema } from '../datatype-payload-validation';
import { ingestExternalTriggerEvent } from './ingestion';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

function migration(number: number, slug: string): string {
  const armed = path.join(REPO, 'libs/papercusp/libs/db/sql', `${number}-${slug}.sql`);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration ${number}-${slug} not found`);
}

let db: MigratedTestDb;
let sql: Sql;
let sourceId: string;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'extingest' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.datatype_registry (
      id text NOT NULL, workspace_id text NOT NULL, title text NOT NULL,
      description text NOT NULL, tier text NOT NULL, work_item_kind text,
      payload_schema jsonb, authoritative_writer text NOT NULL DEFAULT 'papercusp',
      self_improvement jsonb, status text NOT NULL DEFAULT 'active',
      published boolean NOT NULL DEFAULT false, tags text[] NOT NULL DEFAULT '{}',
      embedding text, created_by text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), review_status text NOT NULL DEFAULT 'none',
      pot_slug text, PRIMARY KEY (workspace_id, id)
    );
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    VALUES ('papercusp-workspace', 'papercusp', 'inbox-triage');
  `);
  await sql.unsafe(migration(877, 'canonical-external-datatypes'));
  await sql.unsafe(migration(876, 'external-trigger-core'));
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.trigger_sources (workspace_id, kind, status)
    VALUES ('papercusp-workspace', 'gmail', 'connected') RETURNING id`;
  sourceId = source.id;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('external trigger ingestion core', () => {
  it('seeds the five curated external datatypes with compilable schemas', async () => {
    const rows = await sql<{ id: string; payload_schema: Record<string, unknown> }[]>`
      SELECT id, payload_schema FROM harness_shared.datatype_registry
       WHERE workspace_id = 'papercusp-workspace' ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual([
      'calendar-event',
      'chat-message',
      'contact',
      'email-message',
      'social-post',
    ]);
    expect(rows.every((row) => isCompilableSchema(row.payload_schema))).toBe(true);
  });

  it('normalizes once, emits a derived key, and fans the same event to a second sink', async () => {
    const normalize = vi.fn(() => ({
      id: 'm-1', from: 'ada@example.com', to: ['owner@example.com'],
      subject: 'Hello', text: 'Body',
    }));
    const emit = vi.fn(async () => ({
      ok: true as const, key: 'ext:gmail:message.received', woken: 0,
      notified: [], msgId: null, waiters: 0,
    }));
    const vaultDeliver = vi.fn(async () => ({ id: 'doc-1' }));

    const result = await ingestExternalTriggerEvent(sql, {
      workspaceId: 'papercusp-workspace', sourceId, source: 'gmail',
      event: 'message.received', externalId: 'm-1', datatypeId: 'email-message',
      adapterPayload: { raw: true }, normalize,
      additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
    }, { emit });

    expect(result.ok).toBe(true);
    expect(result.event.key).toBe('ext:gmail:message.received');
    expect(result.event.workspaceId).toBe('papercusp-workspace');
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ key: 'ext:gmail:message.received' }));
    expect(vaultDeliver).toHaveBeenCalledWith(result.event);
    expect(result.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: false }),
      expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered', deduped: false }),
    ]));

    const rows = await sql<{ sink_kind: string; outcome: string }[]>`
      SELECT sink_kind, outcome FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:m-1' ORDER BY sink_kind`;
    expect(rows).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered' },
      { sink_kind: 'personal-vault', outcome: 'delivered' },
    ]);
  });

  it('retries only the failed sink while preserving delivered-sink dedupe', async () => {
    const firstEmit = vi.fn(async () => ({
      ok: true as const, key: 'ext:gmail:message.received', woken: 0,
      notified: [], msgId: null, waiters: 0,
    }));
    const failingVault = vi.fn(async () => {
      throw new Error('vault unavailable');
    });
    const input = {
      workspaceId: 'papercusp-workspace', sourceId, source: 'gmail',
      event: 'message.received', externalId: 'm-retry', datatypeId: 'email-message',
      adapterPayload: {}, normalize: () => ({ id: 'm-retry', subject: 'Retry me' }),
    };

    const first = await ingestExternalTriggerEvent(sql, {
      ...input,
      additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: failingVault }],
    }, { emit: firstEmit });
    expect(first.ok).toBe(false);
    expect(firstEmit).toHaveBeenCalledTimes(1);
    expect(first.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: false }),
      expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'failed', deduped: false }),
    ]));

    const replayEmit = vi.fn(async () => ({
      ok: true as const, key: 'ext:gmail:message.received', woken: 0,
      notified: [], msgId: null, waiters: 0,
    }));
    const recoveredVault = vi.fn(async () => ({ id: 'doc-recovered' }));
    const replay = await ingestExternalTriggerEvent(sql, {
      ...input,
      additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: recoveredVault }],
    }, { emit: replayEmit });

    expect(replay.ok).toBe(true);
    expect(replayEmit).not.toHaveBeenCalled();
    expect(recoveredVault).toHaveBeenCalledTimes(1);
    expect(replay.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: true }),
      expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered', deduped: false }),
    ]));
    const rows = await sql<{ sink_kind: string; outcome: string; attempts: number }[]>`
      SELECT sink_kind, outcome, attempts FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:m-retry' ORDER BY sink_kind`;
    expect(rows).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered', attempts: 1 },
      { sink_kind: 'personal-vault', outcome: 'delivered', attempts: 2 },
    ]);
  });

  it('dedupes provider replay without re-emitting either sink', async () => {
    const emit = vi.fn(async () => ({
      ok: true as const, key: 'ext:gmail:message.received', woken: 0,
      notified: [], msgId: null, waiters: 0,
    }));
    const vaultDeliver = vi.fn(async () => undefined);
    const result = await ingestExternalTriggerEvent(sql, {
      workspaceId: 'papercusp-workspace', sourceId, source: 'gmail',
      event: 'message.received', externalId: 'm-1', datatypeId: 'email-message',
      adapterPayload: {}, normalize: () => ({ id: 'm-1', subject: 'Hello' }),
      additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
    }, { emit });
    expect(result.ok).toBe(true);
    expect(result.deliveries.every((delivery) => delivery.deduped)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(vaultDeliver).not.toHaveBeenCalled();
  });

  it('persists canonical validation failures and emits nothing', async () => {
    const emit = vi.fn();
    const vaultDeliver = vi.fn();
    const result = await ingestExternalTriggerEvent(sql, {
      workspaceId: 'papercusp-workspace', sourceId, source: 'gmail',
      event: 'message.received', externalId: 'm-2', datatypeId: 'email-message',
      adapterPayload: {}, normalize: () => ({ subject: 'missing canonical id' }),
      additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
    }, { emit: emit as never });
    expect(result.ok).toBe(false);
    expect(result.validationErrors?.join(' ')).toMatch(/id/);
    expect(emit).not.toHaveBeenCalled();
    expect(vaultDeliver).not.toHaveBeenCalled();
    const rows = await sql<{ sink_kind: string; outcome: string; error: string }[]>`
      SELECT sink_kind, outcome, error FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:m-2' ORDER BY sink_kind`;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.outcome === 'failed' && /invalid_email-message_payload/.test(row.error))).toBe(true);
  });
});
