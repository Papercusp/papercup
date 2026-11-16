/** Acceptance through the real private operator API; never targets a shared DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { deriveIndexFromContent } from '../lib/agent-tools/plans/derive-index';
import { hashPlanContent } from '../lib/agent-tools/plans/content-hash';
import { readPlanLineNodes, writePlanLineNodes } from '../lib/agent-tools/plans/plan-line-graph';
import { withWorkItemDependencyAdmissionTransaction, mutateWorkItemDependenciesInTransaction } from '../lib/dbos/work-item-deps-store';
import { createWorkItem } from '../lib/work-items';

type Options = { workspace: string; harness: string; base: string; headers: Record<string, string>;
  evidenceDir: string; expectedSha: string };

function toolData(envelope: any) {
  const value = envelope.result?.structuredContent ?? envelope.result?.data
    ?? JSON.parse(envelope.result?.content?.find((c: any) => c.type === 'text' && c.text.trim().startsWith('{'))?.text ?? 'null');
  return value?.data ?? value;
}

export async function measureSavedPlanLinesScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const { sql } = getOrgPg();
  const slug = 'private-saved-lines';
  const scope = { workspaceId: o.workspace, harnessSlug: o.workspace, slug };
  const line = (n: number) => `P-${String(n).padStart(3, '0')}`;
  const lines = Array.from({ length: 26 }, (_, i) =>
    `- **${line(i + 1)}** \`${i === 2 ? 'done' : 'todo'}\` Saved private item ${i + 1}${i >= 22 ? ` blocked-by: ${i === 22 ? 'P-001' : line(i)}` : ''}`);
  const body = (items: string[]) => `---\ntitle: Private saved-line acceptance\nslug: ${slug}\nstatus: draft\n---\n# Private saved-line acceptance\n\n## Items\n\n${items.join('\n')}\n\n## Decisions\n`;
  const original = body(lines.slice(0, 22));
  const saved = body(lines);
  // Reproduce the legacy saved-content/graph split only in this disposable DB.
  await sql`INSERT INTO harness_shared.harness_plans
    (workspace_id,harness_slug,plan_slug,content,content_hash,version,origin,items)
    VALUES (${o.workspace},${scope.harnessSlug},${slug},${original},${hashPlanContent(original)},1,'local',
      ${JSON.stringify(deriveIndexFromContent(original).items)}::text::jsonb)`;
  await withWorkItemDependencyAdmissionTransaction(sql, async tx => {
    const mutations = await writePlanLineNodes(tx, scope, [], deriveIndexFromContent(original).items);
    await mutateWorkItemDependenciesInTransaction(tx, { workspaceId: DEFAULT_COORD_WORKSPACE, itemWorkspaceId: o.workspace, mutations });
  });
  await sql`UPDATE harness_shared.harness_plans SET content=${saved},content_hash=${hashPlanContent(saved)},
    items=${JSON.stringify(deriveIndexFromContent(saved).items)}::text::jsonb
    WHERE workspace_id=${o.workspace} AND harness_slug=${scope.harnessSlug} AND plan_slug=${slug}`;
  const [first] = await readPlanLineNodes(sql, scope);
  const external = await createWorkItem({ kind: 'feature', title: 'Private external dependency',
    summary: 'Retained unrelated dependency endpoint.', harness: scope.harnessSlug,
    workspaceId: o.workspace, createdBy: 'private-saved-lines-fixture' });
  await sql`INSERT INTO harness_shared.work_item_deps
    (workspace_id,blocked_kind,blocked_ref,blocker_kind,blocker_ref,created_by,satisfaction)
    VALUES (${DEFAULT_COORD_WORKSPACE},'feature',${`${scope.harnessSlug}#${first.featureId}`},
      'feature',${`${scope.harnessSlug}#${external.id}`},'private-saved-lines-fixture','success')`;
  const retained = async () => ({
    rows: [...await sql`SELECT jsonb_build_object('row',to_jsonb(w),'xmin',w.xmin::text)::text AS record
      FROM harness_shared.work_items w WHERE workspace_id=${o.workspace} AND harness_slug=${scope.harnessSlug}
      AND plan_slug=${slug} AND plan_line_id < 'P-023' ORDER BY plan_line_id`],
    edges: [...await sql`SELECT jsonb_build_object('row',to_jsonb(d),'xmin',d.xmin::text)::text AS record
      FROM harness_shared.work_item_deps d WHERE workspace_id=${DEFAULT_COORD_WORKSPACE}
      AND created_by='private-saved-lines-fixture' ORDER BY id`],
  });
  const census = async () => [...await sql`SELECT to_jsonb(w)::text AS record FROM harness_shared.work_items w
    WHERE workspace_id=${o.workspace} AND harness_slug=${scope.harnessSlug} ORDER BY feature_id`];
  const requests: unknown[] = [];
  async function invoke(args: Record<string, unknown>) {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST', headers: o.headers,
      body: JSON.stringify({ name: 'plans:backfill-dependency-edges', args: { harness: o.harness, ...args },
        harness: o.harness, callerSid: 'private-saved-lines-' + o.workspace, confirmed: true }),
      signal: AbortSignal.timeout(30_000) });
    const envelope = await response.json() as any;
    requests.push({ status: response.status, args, envelope });
    await writeFile(`${o.evidenceDir}/saved-lines-request-${requests.length}.json`, JSON.stringify(requests.at(-1)), { flag: 'wx' });
    assert.equal(response.status, 200, JSON.stringify(envelope));
    return { envelope, data: toolData(envelope) };
  }
  const savedLines = { slug, expectedVersion: 1, expectedContentHash: hashPlanContent(saved) };
  const before = await census();
  const preview = await invoke({ dryRun: true, savedLines });
  assert.deepEqual(preview.data.missingItems.map((item: any) => item.id), ['P-023', 'P-024', 'P-025', 'P-026']);
  // The public result deliberately samples large row snapshots. Measure the
  // complete population from its canonical reader, not that wire sample.
  const represented = (await readPlanLineNodes(sql, scope)).length;
  assert.equal(represented, 22);
  assert.ok(preview.data.representedRows.length > 0);
  assert.deepEqual(await census(), before, 'preview changed private graph rows');
  await sql`UPDATE harness_shared.work_items SET payload=payload || '{"privateCasControl":true}'::jsonb
    WHERE workspace_id=${o.workspace} AND feature_id=${first.featureId}`;
  const changed = await census();
  const stale = await invoke({ dryRun: false, savedLines: { ...savedLines, preview: preview.data.preview } });
  assert.match(JSON.stringify(stale.envelope), /saved_plan_lines_preview_changed/);
  assert.deepEqual(await census(), changed, 'stale preview changed private graph rows');
  const fresh = await invoke({ dryRun: true, savedLines });
  const prior = await retained();
  const applied = await invoke({ dryRun: false, savedLines: { ...savedLines, preview: fresh.data.preview } });
  assert.equal(applied.data.nodesAdded, 4);
  assert.equal(applied.data.edgesWritten, 4);
  assert.deepEqual(await retained(), prior, 'repair rewrote existing rows or external dependency');
  const after = await readPlanLineNodes(sql, scope);
  assert.equal(after.length, 26);
  const added = await sql`SELECT status,taken_by,payload FROM harness_shared.work_items
    WHERE workspace_id=${o.workspace} AND harness_slug=${scope.harnessSlug} AND plan_slug=${slug} AND plan_line_id >= 'P-023'`;
  assert.equal(added.length, 4);
  for (const row of added) {
    assert.equal(row.status, 'open'); assert.equal(row.taken_by, null);
    assert.equal(row.payload._claimHold, true);
    assert.equal(row.payload.claim_hold_by, 'migration:plan-line-work-item-nodes');
  }
  const settled = await census();
  const repeat = await invoke({ dryRun: false, savedLines: { ...savedLines, preview: fresh.data.preview } });
  assert.equal(repeat.data.alreadyReconciled, true);
  assert.equal(repeat.data.nodesAdded, 0);
  assert.deepEqual(await census(), settled, 'idempotent repair changed private graph rows');

  const memoryId = randomUUID();
  const entityId = randomUUID();
  const userId = o.workspace + '-relink';
  await sql`INSERT INTO harness_shared.memory_canonical (id,payload) VALUES
    (${memoryId},${JSON.stringify({ data: 'Private memory', user_id: userId })}::text::jsonb),
    (${entityId},${JSON.stringify({ data: 'just before end of', user_id: userId,
      entityType: 'COMPOUND', linkedMemoryIds: [memoryId] })}::text::jsonb)`;
  const memoryRows = async () => [...await sql`SELECT jsonb_build_object('row',to_jsonb(m),'xmin',m.xmin::text)::text AS record
    FROM harness_shared.memory_canonical m WHERE id=ANY(${[memoryId, entityId]}::uuid[]) ORDER BY id`];
  const memoryBefore = await memoryRows();
  const response = await fetch(o.base + '/api/user/memory/relink-entities', { method: 'POST', headers: o.headers,
    body: JSON.stringify({ dryRun: true, userId, maxMemories: 1 }), signal: AbortSignal.timeout(30_000) });
  const memory = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(memory));
  assert.equal(memory.ok, true); assert.equal(memory.dryRun, true);
  assert.equal(memory.affectedMemories, 1); assert.equal(memory.junkDeleted, 1);
  assert.deepEqual(await memoryRows(), memoryBefore, 'memory dry-run mutated private corpus');
  const health = await (await fetch(o.base + '/api/health', { signal: AbortSignal.timeout(2_000) })).json() as any;
  assert.equal(health.sha, o.expectedSha, 'private API generation changed during acceptance');
  return { workspace: o.workspace, graph: { represented, added: 4, total: 26,
    stalePreviewRefused: true, existingRowsPreserved: true, externalEdgePreserved: true, idempotent: true,
    newRowsParked: true, requestCount: requests.length }, memory: { status: response.status, ...memory, unchanged: true } };
}
