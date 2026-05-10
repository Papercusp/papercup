/**
 * Periodic poll over harness state that fires push notifications to paired
 * mobile devices when something newsworthy happens.
 *
 * Watches:
 *   - harness_escalations: new or updated row → push intervention
 *   - harness_smoke_test:  status flips to 'fail' → push smoke-fail
 *   - harness_plan_review: row appears → push plan-review
 *
 * Dedupes via in-memory seen-set keyed on `(slug, phase, mtime)` so a
 * given event fires once per server lifetime, not on every poll.
 *
 * Runs every 60s. Cheap — three small SELECTs per workspace.
 */
import { getOrgPg } from '@restart/db-org';
import { notifyWorkspace } from './mobile-push-dispatcher';

const POLL_MS = 60_000;
const seen = new Set<string>();
let started = false;

interface EscalationRow { harness_slug: string; phase: string; mtime_ms: number; workspace_id: string }
interface SmokeRow { harness_slug: string; status: string; mtime_ms: number; workspace_id: string }
interface PlanReviewRow { harness_slug: string; mtime_ms: number; workspace_id: string }

export function startMobileInterventionWatcher(): void {
  if (started) return;
  started = true;
  // First tick after a short warm-up so the boot path doesn't fire on
  // pre-existing rows for an unbounded set of paired devices that joined
  // before this server started.
  setTimeout(() => prime().catch((e) => console.warn('[mobile-watch] prime', e)), 5_000);
  setInterval(() => tick().catch((e) => console.warn('[mobile-watch] tick', e)), POLL_MS).unref();
}

async function prime(): Promise<void> {
  // Seed `seen` with everything currently present so we don't blast pushes
  // for state that existed before this process started.
  const { sql } = getOrgPg();
  const escalations = await sql<EscalationRow[]>`
    SELECT harness_slug, phase, mtime_ms, workspace_id FROM harness_shared.harness_escalations
  `;
  const smokes = await sql<SmokeRow[]>`
    SELECT harness_slug, status, mtime_ms, workspace_id FROM harness_shared.harness_smoke_test
  `;
  const planReviews = await sql<PlanReviewRow[]>`
    SELECT harness_slug, mtime_ms, workspace_id FROM harness_shared.harness_plan_review
  `;
  for (const r of escalations) seen.add(`esc::${r.workspace_id}::${r.harness_slug}::${r.phase}::${r.mtime_ms}`);
  for (const r of smokes) seen.add(`smoke::${r.workspace_id}::${r.harness_slug}::${r.status}::${r.mtime_ms}`);
  for (const r of planReviews) seen.add(`plan::${r.workspace_id}::${r.harness_slug}::${r.mtime_ms}`);
  console.log(`[mobile-watch] primed with ${seen.size} existing rows`);
  // Don't tick immediately after prime — wait the full POLL_MS so push
  // dispatch is bounded to changes after server start.
}

async function tick(): Promise<void> {
  const { sql } = getOrgPg();

  const escalations = await sql<EscalationRow[]>`
    SELECT harness_slug, phase, mtime_ms, workspace_id
    FROM harness_shared.harness_escalations
  `;
  for (const r of escalations) {
    const key = `esc::${r.workspace_id}::${r.harness_slug}::${r.phase}::${r.mtime_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await notifyWorkspace(r.workspace_id, {
      title: 'Harness escalated',
      body: `${r.harness_slug} (${r.phase}) needs your attention.`,
      data: { kind: 'intervention', harness: r.harness_slug, phase: r.phase },
      category: 'intervention',
    });
  }

  const smokes = await sql<SmokeRow[]>`
    SELECT harness_slug, status, mtime_ms, workspace_id
    FROM harness_shared.harness_smoke_test
    WHERE status = 'fail'
  `;
  for (const r of smokes) {
    const key = `smoke::${r.workspace_id}::${r.harness_slug}::${r.status}::${r.mtime_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await notifyWorkspace(r.workspace_id, {
      title: 'Smoke test failing',
      body: `${r.harness_slug} smoke test is failing.`,
      data: { kind: 'smoke-fail', harness: r.harness_slug },
      category: 'smoke-fail',
    });
  }

  const planReviews = await sql<PlanReviewRow[]>`
    SELECT harness_slug, mtime_ms, workspace_id
    FROM harness_shared.harness_plan_review
  `;
  for (const r of planReviews) {
    const key = `plan::${r.workspace_id}::${r.harness_slug}::${r.mtime_ms}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await notifyWorkspace(r.workspace_id, {
      title: 'Plan ready for review',
      body: `${r.harness_slug} has a plan waiting on you.`,
      data: { kind: 'plan-review', harness: r.harness_slug },
      category: 'plan-review',
    });
  }

  // Cap memory: if seen set grows past 5000 entries, drop the oldest half.
  // We don't track insertion order so we re-prime; an event in transit at
  // that moment may double-fire, which is acceptable (push is at-least-once).
  if (seen.size > 5000) {
    seen.clear();
    await prime();
  }
}
