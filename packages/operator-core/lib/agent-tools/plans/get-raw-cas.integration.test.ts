import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { deriveIndexFromContent } from './derive-index';
import { writePlanLineNodes } from './plan-line-graph';
import { recordPlanRevisionInTransaction } from './revisions';
import { hashPlanContent } from './content-hash';
import getTool from './get';
import setContentTool from './set-content';

const HARNESS = 'zzz-exact-raw-cas';
let fx: PlanPgFixture;
const context = () => ({
  workspaceId: fx.workspaceId, harnessSlug: HARNESS, role: 'su', isSuperuser: true,
  principal: { kind: 'agent', slug: 'exact-raw-cas-test', workspaceId: fx.workspaceId },
  signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
}) as never;

function authored(slug: string) {
  return `---
title: Exact raw CAS
slug: ${slug}
created: 2026-11-06
updated: 2026-11-06
status: draft
---

# Exact raw CAS

## Now

**State:** Preserve saved bytes.

**Next:** Verify the reader and writer.

## Background

Keep this prose exactly.

## Phase 1

- **P-001** \`todo\` Preserve author spacing.  — note: Keep this note.

## Decisions
`;
}

function data(result: unknown): Record<string, unknown> {
  const envelope = result as { data?: Record<string, unknown>; content?: Array<{ text?: string }> };
  if (envelope.data) return envelope.data;
  return JSON.parse(envelope.content!.find(entry => entry.text?.startsWith('{'))!.text!);
}

async function read(slug: string, extra: Record<string, unknown> = {}) {
  const result = data(await getTool.handler(getTool.args.parse({
    slug, harness: HARNESS, mode: 'full', includeRaw: true,
    includeHistory: false, includeEnrichments: false, ...extra,
  }), context()));
  return (result.results as Array<Record<string, unknown>>)[0]!;
}

async function seed(slug: string, body: string) {
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, slug, body);
  await fx.admin`UPDATE harness_shared.harness_plans SET content_hash=${hashPlanContent(body)}
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${slug}`;
  const items = deriveIndexFromContent(body).items.map(item => ({ ...item, status: 'wip' as const }));
  await writePlanLineNodes(fx.admin, { workspaceId: fx.workspaceId, harnessSlug: HARNESS, slug }, [], items);
  await fx.admin.begin(async tx => {
    await recordPlanRevisionInTransaction(tx, {
      workspaceId: fx.workspaceId, harnessSlug: HARNESS, planSlug: slug, content: body,
      identity: { ownerId: 'exact-raw-cas-test', ownerLabel: 'exact raw CAS test',
        source: 'static-client', workspaceId: fx.workspaceId, userId: null },
    });
  });
}

beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 120_000);
afterAll(async () => { await fx?.dispose(); });

describe('mutable exact raw and canonical CAS across graph rendering', () => {
  it.each(['structured', 'legacy'])('returns saved %s bytes while retaining graph-owned projections', async kind => {
    const slug = `raw-${kind}`;
    const body = kind === 'structured' ? authored(slug)
      : '# Legacy plan\n\n## Phase 1\n\n- **P-001** `todo` Saved text.  — note: Preserve spacing.\n';
    await seed(slug, body);
    const result = await read(slug);
    expect(result.raw).toBe(body);
    expect(result.contentHash).toBe(hashPlanContent(body));
    expect(result.prose).toContain('`wip`');
    if (kind === 'structured') {
      expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'P-001', storedStatus: 'wip' })]));
    }
    expect(await read(slug, { revision: 1 })).toMatchObject({ raw: body, contentSnapshotHash: hashPlanContent(body) });
  });

  it('accepts the saved-byte hash with the current version and refuses either stale CAS baseline', async () => {
    const slug = 'canonical-cas';
    const body = authored(slug);
    await seed(slug, body);
    // Retain the graph-owned status in the candidate; only the CAS preimage is authored raw.
    const next = body.replace('`todo`', '`wip`').replace('Keep this prose exactly.', 'An intentional prose edit.');
    const write = async (expectedHash: string, expectedVersion: number) => data(await setContentTool.handler(
      setContentTool.args.parse({ slug, harness: HARNESS, content: next, expectedHash, expectedVersion }), context()));
    const hash = hashPlanContent(body);
    expect(await write('stale-hash', 1)).toMatchObject({ error: 'stale', currentContent: body, currentHash: hash, currentVersion: 1 });
    expect(await write(hash, 0)).toMatchObject({ error: 'stale', currentContent: body, currentHash: hash, currentVersion: 1 });
    expect(await write(hash, 1)).toMatchObject({ ok: true });
    const stored = await fx.admin<{ content: string; content_hash: string; version: number }[]>`
      SELECT content, content_hash, version::int AS version FROM harness_shared.harness_plans
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${slug}`;
    expect(stored[0]).toMatchObject({ content: next, content_hash: hashPlanContent(next), version: 2 });
    expect(await read(slug)).toMatchObject({ raw: next, contentHash: hashPlanContent(next), version: 2 });
  });
});
