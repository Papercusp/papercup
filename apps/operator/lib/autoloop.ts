/**
 * AutoLoop ticker — periodic firing of harness directors based on each
 * harness's director-config.json.
 *
 * Polls every TICK_INTERVAL_MS (default 30s):
 *   1. Enumerate registered harnesses (via /api/harness/projects)
 *   2. For each, read .harness/director-config.json
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
import { getOrgPg } from '@restart/db-org';
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

async function ensureTable(): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    CREATE TABLE IF NOT EXISTS harness_shared.autoloop_state (
      harness_slug TEXT PRIMARY KEY,
      last_fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_role TEXT,
      last_status TEXT,
      consecutive_errors INT NOT NULL DEFAULT 0
    )
  `;
}

async function listHarnesses(operatorBase: string): Promise<HarnessRow[]> {
  try {
    const r = await fetch(`${operatorBase}/api/harness/projects`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    const d: any = await r.json();
    return Array.isArray(d?.projects) ? d.projects : [];
  } catch {
    return [];
  }
}

async function readDirectorConfig(harnessPath: string): Promise<DirectorConfig | null> {
  const cfg = join(harnessPath, '.harness', 'director-config.json');
  if (!existsSync(cfg)) return null;
  try {
    return JSON.parse(await fs.readFile(cfg, 'utf8')) as DirectorConfig;
  } catch {
    return null;
  }
}

async function shouldFire(slug: string, intervalSeconds: number): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ last_fired_at: Date }[]>`
    SELECT last_fired_at FROM harness_shared.autoloop_state WHERE harness_slug = ${slug}
  `;
  if (rows.length === 0) return true; // never fired
  const elapsed = (Date.now() - new Date(rows[0].last_fired_at).getTime()) / 1000;
  return elapsed >= intervalSeconds;
}

async function recordFire(slug: string, role: string, status: string, errorBumped: boolean): Promise<void> {
  const { sql } = getOrgPg();
  if (errorBumped) {
    await sql`
      INSERT INTO harness_shared.autoloop_state (harness_slug, last_fired_at, last_role, last_status, consecutive_errors)
      VALUES (${slug}, now(), ${role}, ${status}, 1)
      ON CONFLICT (harness_slug) DO UPDATE
        SET last_fired_at = now(),
            last_role = EXCLUDED.last_role,
            last_status = EXCLUDED.last_status,
            consecutive_errors = harness_shared.autoloop_state.consecutive_errors + 1
    `;
  } else {
    await sql`
      INSERT INTO harness_shared.autoloop_state (harness_slug, last_fired_at, last_role, last_status, consecutive_errors)
      VALUES (${slug}, now(), ${role}, ${status}, 0)
      ON CONFLICT (harness_slug) DO UPDATE
        SET last_fired_at = now(),
            last_role = EXCLUDED.last_role,
            last_status = EXCLUDED.last_status,
            consecutive_errors = 0
    `;
  }
}

async function fireDirector(operatorBase: string, slug: string, role: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await fetch(`${operatorBase}/api/harness/${encodeURIComponent(slug)}/invoke?role=${encodeURIComponent(role)}`, {
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
    const cfg = await readDirectorConfig(h.path);
    if (!cfg?.autoLoop) continue;
    const interval = Number(cfg.autoIntervalSeconds ?? 60);
    if (interval < 30) continue; // hard floor
    const due = await shouldFire(h.slug, interval);
    if (!due) continue;

    // Fire-and-forget: record the fire BEFORE awaiting so a slow director
    // doesn't get fired twice in overlapping ticks. Bump errors only if
    // the request itself fails (the director may legitimately take minutes).
    const role = 'director';
    // eslint-disable-next-line no-console
    console.log(`[autoloop] firing ${h.slug} → ${role} (interval=${interval}s)`);
    await recordFire(h.slug, role, 'firing', false);
    fireDirector(operatorBase, h.slug, role).then(
      (r) => {
        if (!r.ok) {
          // eslint-disable-next-line no-console
          console.warn(`[autoloop] ${h.slug} fire FAILED: ${r.detail}`);
          recordFire(h.slug, role, `error: ${r.detail}`, true).catch(() => { /* ignore */ });
        } else {
          recordFire(h.slug, role, 'ok', false).catch(() => { /* ignore */ });
        }
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.warn(`[autoloop] ${h.slug} fire threw: ${err}`);
        recordFire(h.slug, role, `throw: ${err}`, true).catch(() => { /* ignore */ });
      },
    );
  }
}

export function startAutoLoopOnce(): void {
  if (started) return;
  started = true;
  // Pin a globalThis flag so HMR doesn't re-arm.
  if ((globalThis as any).__papercuspAutoLoopArmed) return;
  (globalThis as any).__papercuspAutoLoopArmed = true;

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';

  ensureTable()
    .then(() => {
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
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[autoloop] failed to bootstrap:', e);
    });
}

export function stopAutoLoop(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  (globalThis as any).__papercuspAutoLoopArmed = false;
  started = false;
}

/** Test/diagnostic: read current state for a harness. */
export async function getAutoLoopState(slug: string): Promise<any | null> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT harness_slug, last_fired_at, last_role, last_status, consecutive_errors
    FROM harness_shared.autoloop_state WHERE harness_slug = ${slug}
  `;
  return rows.length > 0 ? rows[0] : null;
}
