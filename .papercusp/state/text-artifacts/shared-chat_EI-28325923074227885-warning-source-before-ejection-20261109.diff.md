---
rel_path: "shared-chat/EI-28325923074227885-warning-source-before-ejection-20261109.diff"
updated_at: 1794260759713
_body: "content"
---

Exact same-owner advisory-warning prototype preserved before D019 dependency-cycle ejection. All five working hashes match the original 16:17 local-proof checkpoint. This archive is source preservation, not fresh acceptance or publication. Restore only after current base reconciliation, all appropriate tests and normal locks; do not change the historical ledger or B688.

673d3425fc5f854b24ae352b185ec3ca368b78628cc4e84b215e4fc0e72f5005  packages/operator-core/lib/edit-attribution.ts
d852a592e113e8104f94c82884a79ff52b50f8f165f183036f88b00469df890b  packages/operator-core/lib/agent-tools/locks/attribution-nudge.ts
a38465780e9bd3b8df7b485d034897bf75444d1d72012bcffb53ff3e4f484dda  packages/operator-core/lib/agent-tools/locks/attribution-nudge.test.ts
b0a817fabc27588f17bb129e3cc89b39621cbe6431e58cfce3cb885d0f449340  packages/operator-core/lib/agent-tools/locks/attribution-nudge.integration.test.ts
1df9656aea6212450cc3084a9b042412844c33c352f0901afd7b7e3d7b9a9524  packages/operator-core/lib/agent-tools/locks/acquire.ts
diff --git a/packages/operator-core/lib/agent-tools/locks/acquire.ts b/packages/operator-core/lib/agent-tools/locks/acquire.ts
index b3d5cc0804..be926076ab 100644
--- a/packages/operator-core/lib/agent-tools/locks/acquire.ts
+++ b/packages/operator-core/lib/agent-tools/locks/acquire.ts
@@ -249,10 +249,14 @@ export default defineTool({
     .passthrough(),
   async handler(args, ctx) {
     const { ownerId, ownerLabel, coordinationDomain: defaultCoordinationDomain } = readFileLockIdentity(ctx);
+    // Keep the nudge and the eventual (possibly queued) edit on one goal snapshot.
+    const goalRef = readAgentStateStamp(ownerId).goalRef ?? undefined;
     // P-010 (code-intel-delivery-and-outcomes-2026-10-26, SPEC-P-010): start the "holds
     // no work item" read now so it overlaps the grant; every grant below carries it.
     const attributionNudgeP = startAttributionNudge({
       ownerId,
+      goalRef,
+      lockIntent: args.intent,
       resolveWorkspaceId: () => resolveAgentIdentity(ctx).workspaceId,
       resolveSql: () => getOrgPg().sql as unknown as NudgeSql,
     });
@@ -349,7 +353,6 @@ export default defineTool({
     // Snapshot once, before either the instant-grant or queued-edit path. An owner can
     // hold several work-items and change its active goal while a waiter is blocked; the
     // queue-time pointer is the only honest attribution for the eventual edit.
-    const goalRef = readAgentStateStamp(ownerId).goalRef ?? undefined;
 
     // ── GOAL-mode never-implement gate (EI-20581099901890760) ────────────
     // An automatic per-edit hook claim (intent 'PreToolUse:*') by a session
diff --git a/packages/operator-core/lib/agent-tools/locks/attribution-nudge.integration.test.ts b/packages/operator-core/lib/agent-tools/locks/attribution-nudge.integration.test.ts
index d7655297dc..434521b968 100644
--- a/packages/operator-core/lib/agent-tools/locks/attribution-nudge.integration.test.ts
+++ b/packages/operator-core/lib/agent-tools/locks/attribution-nudge.integration.test.ts
@@ -26,12 +26,14 @@ beforeEach(async () => {
   await db.sql.unsafe('TRUNCATE harness_shared.work_items');
 });
 
-async function hold(owner: string, status: string, workspace = WS): Promise<void> {
+async function hold(owner: string, status: string, workspace = WS): Promise<string> {
   seq += 1;
+  const id = `WI-nudge-${seq}`;
   await db.sql`
     INSERT INTO harness_shared.work_items
       (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts)
-    VALUES ('papercusp', ${`WI-nudge-${seq}`}, 'change', 'nudge fixture', ${status}, ${owner}, ${workspace}, 100, 0)`;
+    VALUES ('papercusp', ${id}, 'change', 'nudge fixture', ${status}, ${owner}, ${workspace}, 100, 0)`;
+  return id;
 }
 
 const nudgeFor = (ownerId: string) =>
@@ -63,4 +65,23 @@ describe('attribution nudge against real Postgres', () => {
     await expect(nudgeFor('su-empty')).resolves.toBe(ATTRIBUTION_NUDGE);
     await expect(nudgeFor('su-elsewhere')).resolves.toBe(ATTRIBUTION_NUDGE);
   });
+
+  it('warns before independent edits silently join a different held app goal', async () => {
+    const app = await hold('su-two-lanes', 'blocked');
+    const regression = await hold('su-two-lanes', 'wip');
+    const warning = await readAttributionNudge({
+      sql: db.sql as unknown as NudgeSql, workspaceId: WS, ownerId: 'su-two-lanes',
+      goalRef: app, lockIntent: 'PreToolUse:Edit',
+      declaredIntent: `${regression}: independent source and test repair`, timeoutMs: 5_000,
+    });
+    expect(warning).toContain(app);
+    expect(warning).toContain(regression);
+    expect(warning).toContain('work_items:claim');
+    const rows = await db.sql<{ feature_id: string; taken_by: string }[]>`
+      SELECT feature_id, taken_by FROM harness_shared.work_items ORDER BY feature_id`;
+    expect(rows).toEqual([
+      { feature_id: app, taken_by: 'su-two-lanes' },
+      { feature_id: regression, taken_by: 'su-two-lanes' },
+    ].sort((a, b) => a.feature_id.localeCompare(b.feature_id)));
+  });
 });
diff --git a/packages/operator-core/lib/agent-tools/locks/attribution-nudge.test.ts b/packages/operator-core/lib/agent-tools/locks/attribution-nudge.test.ts
index a7b7aa754a..4d4cab5500 100644
--- a/packages/operator-core/lib/agent-tools/locks/attribution-nudge.test.ts
+++ b/packages/operator-core/lib/agent-tools/locks/attribution-nudge.test.ts
@@ -88,3 +88,46 @@ describe('startAttributionNudge', () => {
     })).resolves.toBe(ATTRIBUTION_NUDGE);
   });
 });
+
+describe('active goal conflicts in the edit attribution nudge', () => {
+  const held = [
+    { harness_slug: 'papercusp', feature_id: 'WI-12' },
+    { harness_slug: 'papercusp', feature_id: 'WI-123' },
+  ];
+
+  it('discloses the old active goal when the current edit names a different held item', async () => {
+    const { sql } = stubSql(async () => held);
+    const warning = await readAttributionNudge({
+      sql, workspaceId: 'ws', ownerId: 'su-a', goalRef: 'WI-12',
+      lockIntent: 'WI-123: add the independent source and regression tests',
+    });
+    expect(warning).toContain('WI-12');
+    expect(warning).toContain('WI-123');
+    expect(warning).toContain('work_items:claim');
+  });
+
+  it('checks the declared intent for automatic edits without treating a hook label as work', async () => {
+    const { sql } = stubSql(async () => held);
+    await expect(readAttributionNudge({
+      sql, workspaceId: 'ws', ownerId: 'su-a', goalRef: 'WI-12',
+      lockIntent: 'PreToolUse:Edit', declaredIntent: 'WI-123: independent regression',
+    })).resolves.toContain('WI-123');
+  });
+
+  it('preserves an explicit per-edit choice even when the broader declared intent differs', async () => {
+    const { sql } = stubSql(async () => held);
+    await expect(readAttributionNudge({
+      sql, workspaceId: 'ws', ownerId: 'su-a', goalRef: 'WI-12',
+      lockIntent: 'WI-12: protect the app source', declaredIntent: 'WI-123: independent regression',
+    })).resolves.toBeUndefined();
+  });
+
+  it('does not infer a conflict from multiple named goals or a non-held item', async () => {
+    const { sql } = stubSql(async () => held);
+    for (const declaredIntent of ['WI-12 and WI-123', 'WI-999: another lane']) {
+      await expect(readAttributionNudge({
+        sql, workspaceId: 'ws', ownerId: 'su-a', goalRef: 'WI-12', declaredIntent,
+      })).resolves.toBeUndefined();
+    }
+  });
+});
diff --git a/packages/operator-core/lib/agent-tools/locks/attribution-nudge.ts b/packages/operator-core/lib/agent-tools/locks/attribution-nudge.ts
index b7d8fa509d..b492695ccd 100644
--- a/packages/operator-core/lib/agent-tools/locks/attribution-nudge.ts
+++ b/packages/operator-core/lib/agent-tools/locks/attribution-nudge.ts
@@ -19,6 +19,9 @@
  */
 
 import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
+import { readEditorHeldWorkItems, resolveEditWorkItem } from '../../edit-attribution';
+import { getPresence } from '../coordination/presence';
+import { isLifecycleIntent } from '../coordination/presence-payload';
 
 export const ATTRIBUTION_NUDGE =
   'Attribution: you hold no work item, so this edit is recorded unattributed '
@@ -67,6 +70,10 @@ export async function readAttributionNudge(input: {
   sql: NudgeSql | null | undefined;
   workspaceId: string | null | undefined;
   ownerId: string | null | undefined;
+  goalRef?: string | null;
+  lockIntent?: string | null;
+  declaredIntent?: string | null;
+  readDeclaredIntent?: () => Promise<string | null>;
   timeoutMs?: number;
 }): Promise<string | undefined> {
   if (!input.sql || !input.workspaceId || !input.ownerId) return undefined;
@@ -76,11 +83,42 @@ export async function readAttributionNudge(input: {
     timer.unref?.();
   });
   try {
-    const held = await Promise.race([
-      ownerHoldsOpenWorkItem(input.sql, input.workspaceId, input.ownerId),
+    const sql = input.sql;
+    const workspaceId = input.workspaceId;
+    const ownerId = input.ownerId;
+    const measure = async (): Promise<string | undefined> => {
+      if (!input.goalRef) {
+        return await ownerHoldsOpenWorkItem(sql, workspaceId, ownerId) === false
+          ? ATTRIBUTION_NUDGE : undefined;
+      }
+      // Reuse the actual edit writer's held population and precedence. A warning
+      // never changes the pointer, the edit ledger or git-sync cohort membership.
+      const held = await readEditorHeldWorkItems(
+        sql as Parameters<typeof readEditorHeldWorkItems>[0], workspaceId, ownerId,
+      );
+      if (held === null) return undefined;
+      if (held.length === 0) return ATTRIBUTION_NUDGE;
+      const declaredIntent = input.declaredIntent ?? await input.readDeclaredIntent?.() ?? null;
+      const intents = {
+        held,
+        lockIntent: isLifecycleIntent(input.lockIntent) ? null : input.lockIntent ?? null,
+        declaredIntent: isLifecycleIntent(declaredIntent) ? null : declaredIntent,
+      };
+      const active = resolveEditWorkItem({ ...intents, goalRef: input.goalRef });
+      const named = resolveEditWorkItem({ ...intents, goalRef: null });
+      if (active.resolution !== 'goal-ref' ||
+          !['lock-intent', 'declared-intent'].includes(named.resolution) ||
+          named.workItemId === active.workItemId) return undefined;
+      return `Attribution: this edit names held work item ${named.workItemId}, but the active goal `
+        + `is ${active.workItemId}. The explicit active goal still controls edit attribution and `
+        + 'git-sync atomic cohorts. If this edit belongs to the named item, reclaim it with '
+        + `work_items:claim { id:"${named.workItemId}" } before editing; declaring intent alone `
+        + 'does not switch the active goal. No claim or attribution was changed by this warning.';
+    };
+    return await Promise.race([
+      measure().catch(() => undefined),
       timedOut,
-    ]);
-    return held === false ? ATTRIBUTION_NUDGE : undefined;
+    ]) ?? undefined;
   } finally {
     if (timer) clearTimeout(timer);
   }
@@ -92,6 +130,8 @@ export async function readAttributionNudge(input: {
  */
 export function startAttributionNudge(input: {
   ownerId: string | null | undefined;
+  goalRef?: string;
+  lockIntent?: string;
   resolveWorkspaceId: () => string | null | undefined;
   resolveSql: () => NudgeSql | null | undefined;
 }): Promise<string | undefined> {
@@ -100,6 +140,11 @@ export function startAttributionNudge(input: {
       sql: input.resolveSql(),
       workspaceId: input.resolveWorkspaceId(),
       ownerId: input.ownerId,
+      goalRef: input.goalRef,
+      lockIntent: input.lockIntent,
+      readDeclaredIntent: input.goalRef && input.ownerId
+        ? async () => (await getPresence(input.ownerId!))?.intent ?? null
+        : undefined,
     }).catch(() => undefined);
   } catch {
     return Promise.resolve(undefined);
diff --git a/packages/operator-core/lib/edit-attribution.ts b/packages/operator-core/lib/edit-attribution.ts
index 493b31210b..0a8d814c08 100644
--- a/packages/operator-core/lib/edit-attribution.ts
+++ b/packages/operator-core/lib/edit-attribution.ts
@@ -141,7 +141,7 @@ const EDIT_HELD_SET_LIMIT = 100;
  * carry-brief's readHeldWorkItems also loads summaries and checkpoints — too heavy for the
  * per-edit lock path — so this is the two-column form of the same population.
  */
-async function readEditorHeldWorkItems(
+export async function readEditorHeldWorkItems(
   sql: ReturnType<typeof getOrgPg>['sql'],
   workspaceId: string,
   agentId: string,

