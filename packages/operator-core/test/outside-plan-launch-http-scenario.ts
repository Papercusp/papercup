/** R1 transport proof on the maintained private current-build operator. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { prepareCodexBudgetScenario } from './codex-budget-http-scenario';

export async function measureOutsidePlanLaunchScenario(o: {
  workspace: string; base: string; headers: Record<string, string>; evidenceDir: string;
}) {
  assert.match(o.workspace, /^test-runtime-/);
  await prepareCodexBudgetScenario(o.workspace);
  const [{ getOrgPg }, { readSuperuserToken }] = await Promise.all([
    import('@papercusp/db-org'), import('../lib/superuser-token'),
  ]);
  const token = readSuperuserToken();
  assert.ok(token, 'private bearer required');
  const headers = { ...o.headers, Authorization: `Bearer ${token}` };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(o.base + '/api' + path, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const bootstrap = '/agent-mcp/console/bootstrap-su';
  const common = { agent: 'codex', workspace: o.workspace, model: 'gpt-6.1-sol:xhigh',
    model_source: 'explicit', account: 'default', cwd: process.cwd(), context_size: 'trimmed' };
  const mixed = await post(bootstrap, { ...common, plan_slug: 'P', plan_ref: 'X' });
  assert.equal(mixed.status, 400, JSON.stringify(mixed));
  assert.match(mixed.body.error, /mutually exclusive/);
  const overflow = await post(bootstrap, { ...common, plan_ref: '😀'.repeat(201) });
  assert.equal(overflow.status, 400, JSON.stringify(overflow));
  const owner = `su-private-outside-${randomUUID()}`;
  const planRef = '  outside:😀  ';
  const launched = await post(bootstrap, { ...common, owner_id: owner, plan_ref: planRef,
    bootstrap_idempotency_key: `outside-${owner}` });
  assert.equal(launched.status, 200, JSON.stringify(launched));
  assert.equal(launched.body.outsidePlanRef, planRef);
  assert.equal(launched.body.envelopeEnv.PAPERCUSP_SID, owner);
  const { sql } = getOrgPg();
  const [stored] = await sql`SELECT outside_plan_ref, plan_slug FROM harness_shared.adv_sessions
    WHERE id = ${launched.body.sessionId} AND workspace_id = ${o.workspace}`;
  assert.equal(stored.outside_plan_ref, planRef);
  assert.equal(stored.plan_slug, null);

  const url = new URL('/api/mcp', o.base);
  for (const [key, value] of Object.entries({ superuser: '1', workspace: o.workspace,
    client: owner, format: 'json', structured: '1' })) url.searchParams.set(key, value);
  const client = new Client({ name: 'outside-plan-r1-http-proof', version: '1' });
  let whoami: Record<string, unknown> | undefined;
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }), { timeout: 30_000 });
    const result = await client.callTool({ name: 'coord:whoami', arguments: {} });
    for (const entry of result.content as Array<{ type: string; text?: string }>) {
      if (entry.type !== 'text' || !entry.text) continue;
      try { const parsed = JSON.parse(entry.text); if (parsed.ownerId === owner) whoami = parsed; } catch { /* other tool advisories */ }
    }
  } finally { await client.close(); }
  assert.equal(whoami?.outsidePlanRef, planRef, JSON.stringify(whoami));

  const conflict = await post(bootstrap, { ...common, owner_id: owner, plan_ref: 'different' });
  assert.equal(conflict.status, 400, JSON.stringify(conflict));
  assert.match(conflict.body.error, /persisted/);
  const resumeConflict = await post(bootstrap + '/session-resumed', {
    advSessionId: launched.body.sessionId, resumeClaimKey: 'outside-ref-conflict', planRef: 'different',
  });
  assert.equal(resumeConflict.status, 409, JSON.stringify(resumeConflict));
  const ordinary = await post(bootstrap, { ...common, owner_id: `su-private-ordinary-${randomUUID()}` });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary));
  assert.equal(ordinary.body.outsidePlanRef ?? null, null);
  const receipt = { workspace: o.workspace, owner, planRef, sessionId: launched.body.sessionId,
    bootstrapStatus: launched.status, whoamiPlanRef: whoami?.outsidePlanRef,
    mixedStatus: mixed.status, overflowStatus: overflow.status, conflictStatus: conflict.status,
    resumeConflictStatus: resumeConflict.status, ordinaryStatus: ordinary.status, nativeLaunched: false };
  await writeFile(join(o.evidenceDir, 'outside-plan-launch-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
  return receipt;
}
