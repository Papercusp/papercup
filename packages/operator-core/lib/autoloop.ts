/**
 * AutoLoop ticker — periodic firing of harness directors based on each
 * harness's director-config.json.
 *
 * Polls every TICK_INTERVAL_MS (default 30s):
 *   1. Enumerate registered harnesses (via /api/harness/projects)
 *   2. For each, read .papercusp/director-config.json
 *   3. If autoLoop=true and (now - last_fired_at) >= autoIntervalSeconds:
 *      POST /api/harness/<slug>/invoke?role=director (fire-and-forget)
 *      Persist last_fired_at to harness_shared.autoloop_state
 *
 * State table is in PG so a process restart picks up where it left off
 * (within at most one tick interval of slop). The actual ticker is in-process
 * — when the operator restarts, the ticker dies, but a new one starts on
 * boot and resumes from the persisted state.
 *
 * Operator startup wires the ticker via `startAutoLoopOnce()`. Idempotent.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { dbosAutoloopActive } from './dbos/dbos-flags';
import { loopbackFetch } from './loopback-fetch';

const at = generated.autoloopStateInHarnessShared;
import { activeWorkspaceId } from './workspace-registry';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

const TICK_INTERVAL_MS = Number(process.env.PAPERCUSP_AUTOLOOP_TICK_MS ?? 30_000);
const FIRE_TIMEOUT_MS = Number(process.env.PAPERCUSP_AUTOLOOP_FIRE_TIMEOUT_MS ?? 120_000);

interface DirectorConfig {
  autoLoop?: boolean;
  autoIntervalSeconds?: number;
}

interface HarnessRow {
  slug: string;
  path: string;
  parent_slug?: string | null;
  hasState?: boolean;
}

let started = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;

export async function listHarnesses(operatorBase: string, workspaceId?: string): Promise<HarnessRow[]> {
  try {
    // /projects/lite returns slug+path+harnessDir without the per-project
    // PG hits we don't need here (autoloop only checks director-config.json
    // on disk). Cuts the hot-path autoloop tick from ~5s to <50ms.
    // Phase E (P-020): scope to a workspace via `?ws=` (the workspace middleware
    // reads the query param — loopbackFetch can't set the header). Omitted → the
    // operator resolves its global active workspace (today's behavior).
    const url = workspaceId
      ? `${operatorBase}/api/harness/projects/lite?ws=${encodeURIComponent(workspaceId)}`
      : `${operatorBase}/api/harness/projects/lite`;
    const r = await loopbackFetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const d: any = await r.json();
    return Array.isArray(d?.projects) ? d.projects : [];
  } catch {
    return [];
  }
}

export async function readDirectorConfig(harnessPath: string): Promise<DirectorConfig | null> {
  const cfg = join(harnessPath, '.papercusp', 'director-config.json');
  if (!existsSync(cfg)) return null;
  try {
    return JSON.parse(await fs.readFile(cfg, 'utf8')) as DirectorConfig;
  } catch {
    return null;
  }
}

export async function shouldFire(slug: string, role: string, intervalSeconds: number): Promise<boolean> {
  const { db } = getOrgPg();
  // Phase E (P-020): fire-state is per-(workspace, slug, role). Scope by the
  // current workspace (set by the tick's runWithWorkspace, else the global) so
  // the same slug in two workspaces fires independently.
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ last_fired_at: at.lastFiredAt })
    .from(at)
    .where(and(eq(at.workspaceId, ws), eq(at.harnessSlug, slug), eq(at.role, role)));
  if (rows.length === 0) return true; // never fired for this (workspace, role)
  const elapsed = (Date.now() - new Date(rows[0].last_fired_at).getTime()) / 1000;
  return elapsed >= intervalSeconds;
}

export async function recordFire(slug: string, role: string, status: string, errorBumped: boolean): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  if (errorBumped) {
    await db
      .insert(at)
      .values({
        harnessSlug: slug,
        role,
        lastFiredAt: dsql`now()` as any,
        lastStatus: status,
        consecutiveErrors: 1,
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [at.workspaceId, at.harnessSlug, at.role],
        set: {
          lastFiredAt: dsql`now()`,
          lastStatus: dsql`EXCLUDED.last_status`,
          consecutiveErrors: dsql`${at.consecutiveErrors} + 1`,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
  } else {
    await db
      .insert(at)
      .values({
        harnessSlug: slug,
        role,
        lastFiredAt: dsql`now()` as any,
        lastStatus: status,
        consecutiveErrors: 0,
        workspaceId: ws,
      })
      .onConflictDoUpdate({
        target: [at.workspaceId, at.harnessSlug, at.role],
        set: {
          lastFiredAt: dsql`now()`,
          lastStatus: dsql`EXCLUDED.last_status`,
          consecutiveErrors: 0,
          workspaceId: dsql`EXCLUDED.workspace_id`,
        },
      });
  }
}

interface RoleConfig {
  cadence?: number;
}

interface HarnessConfig {
  roles?: Record<string, RoleConfig>;
}

export async function readHarnessConfig(harnessPath: string): Promise<HarnessConfig | null> {
  const cfg = join(harnessPath, '.papercusp', 'config.json');
  if (!existsSync(cfg)) return null;
  try {
    return JSON.parse(await fs.readFile(cfg, 'utf8')) as HarnessConfig;
  } catch {
    return null;
  }
}

export async function fireDirector(operatorBase: string, slug: string, role: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    // Phase E (P-020): resolve the harness in the CURRENT workspace (set by the
    // tick's runWithWorkspace, else the global) via `?ws=` — loopbackFetch can't
    // set the header, and without it the invoke would resolve the slug in the
    // operator's global workspace (wrong one under the shared operator).
    const ws = encodeURIComponent(activeWorkspaceId());
    const r = await loopbackFetch(`${operatorBase}/api/harness/${encodeURIComponent(slug)}/invoke?role=${encodeURIComponent(role)}&ws=${ws}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeoutMs: FIRE_TIMEOUT_MS }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS + 30_000),
    });
    if (r.ok) return { ok: true };
    const text = await r.text().catch(() => '');
    return { ok: false, detail: `HTTP ${r.status}: ${text.slice(0, 200)}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 200) };
  }
}

async function tickOnce(operatorBase: string): Promise<void> {
  const harnesses = await listHarnesses(operatorBase);
  for (const h of harnesses) {
    if (stopped) return;
    const dirCfg = await readDirectorConfig(h.path);
    if (!dirCfg?.autoLoop) continue;
    const harnessCfg = await readHarnessConfig(h.path);
    const baseInterval = Math.max(30, Number(dirCfg.autoIntervalSeconds ?? 60)); // hard floor 30s

    // Roles to consider: always 'director' (using director-config.autoIntervalSeconds);
    // also coordinator + auditor IF declared in roles config with a `cadence` field.
    const rolesToFire: { role: string; intervalSeconds: number }[] = [
      { role: 'director', intervalSeconds: baseInterval },
    ];
    const allRoles = harnessCfg?.roles ?? {};
    for (const r of ['coordinator', 'auditor']) {
      const cad = Number(allRoles[r]?.cadence ?? 0);
      if (cad >= 30) rolesToFire.push({ role: r, intervalSeconds: cad });
    }

    for (const { role, intervalSeconds } of rolesToFire) {
      if (stopped) return;
      const due = await shouldFire(h.slug, role, intervalSeconds);
      if (!due) continue;

      // eslint-disable-next-line no-console
      console.log(`[autoloop] firing ${h.slug} → ${role} (interval=${intervalSeconds}s)`);
      await recordFire(h.slug, role, 'firing', false);
      fireDirector(operatorBase, h.slug, role).then(
        (r) => {
          if (!r.ok) {
            // eslint-disable-next-line no-console
            console.warn(`[autoloop] ${h.slug}/${role} fire FAILED: ${r.detail}`);
            recordFire(h.slug, role, `error: ${r.detail}`, true).catch(() => { /* ignore */ });
          } else {
            recordFire(h.slug, role, 'ok', false).catch(() => { /* ignore */ });
          }
        },
        (err) => {
          // eslint-disable-next-line no-console
          console.warn(`[autoloop] ${h.slug}/${role} fire threw: ${err}`);
          recordFire(h.slug, role, `throw: ${err}`, true).catch(() => { /* ignore */ });
        },
      );
    }
  }
}

// Backoff state lives on globalThis so HMR (which creates a fresh module
// instance) doesn't reset it and re-fire bootstrap on every page load.
const BOOTSTRAP_BACKOFF_MS = Number(process.env.PAPERCUSP_AUTOLOOP_BACKOFF_MS ?? 60_000);
function bootstrapState(): { lastAttempt: number; armed: boolean } {
  const g = globalThis as any;
  if (!g.__papercuspAutoLoop) g.__papercuspAutoLoop = { lastAttempt: 0, armed: false };
  return g.__papercuspAutoLoop;
}

export function startAutoLoopOnce(): void {
  // The legacy in-process ticker stands down EXACTLY when the DBOS autoloop is
  // active (Option 2: default-on with the orchestrator) — same predicate as the
  // bootstrap registration, so exactly one fires (no gap, no double-fire). It runs
  // when the DBOS autoloop is disabled: PAPERCUSP_DBOS_AUTOLOOP=0 (just the autoloop)
  // or PAPERCUSP_DBOS_ORCHESTRATOR=0 (full legacy revert).
  if (dbosAutoloopActive()) return;
  if (started) return;
  started = true;
  const state = bootstrapState();
  if (state.armed) return;
  // Skip if a recent bootstrap attempt is still within the backoff window —
  // prevents per-request retry storms when Postgres is connection-saturated.
  const since = Date.now() - state.lastAttempt;
  if (state.lastAttempt > 0 && since < BOOTSTRAP_BACKOFF_MS) return;
  state.lastAttempt = Date.now();

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

  // The autoloop_state table is defined by the migration baseline now — no
  // runtime DDL to await before arming the ticker.
  state.armed = true;
  // eslint-disable-next-line no-console
  console.log(`[autoloop] armed (tick=${TICK_INTERVAL_MS}ms, op=${operatorBase})`);
  const tick = async () => {
    if (stopped) return;
    try { await tickOnce(operatorBase); } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[autoloop] tick error:', e);
    }
    if (!stopped) timer = setTimeout(tick, TICK_INTERVAL_MS);
  };
  timer = setTimeout(tick, 5_000); // first tick after 5s warmup
}

export function stopAutoLoop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  (globalThis as any).__papercuspAutoLoop = { lastAttempt: 0, armed: false };
  started = false;
}

/** Test/diagnostic: read current state for a harness (all roles). */
export async function getAutoLoopState(slug: string): Promise<any[] | null> {
  const { db } = getOrgPg();
  const rows = await db
    .select({
      harness_slug: at.harnessSlug,
      role: at.role,
      last_fired_at: at.lastFiredAt,
      last_status: at.lastStatus,
      consecutive_errors: at.consecutiveErrors,
    })
    .from(at)
    .where(eq(at.harnessSlug, slug))
    .orderBy(at.role);
  return rows.length > 0 ? rows : null;
}
