/**
 * Wave-advance sweep — LIVE adapters + lifecycle (P-009b-ii).
 *
 * The impure half of the sweep: the real `WaveSweepDeps` (PG queries, plan read,
 * promote launch) + the periodic `setInterval` lifecycle, mirroring
 * `harness-status-sweep.ts`. The pure orchestration + decision live in
 * `wave-advance-sweep.ts` / `waves.ts` and are unit-tested there.
 *
 * ⚠️ UNVERIFIED until a host run (promote-policy-and-waves §Now): these adapters
 * compile but have not been exercised against a live harness. In particular
 * `promoteWave` launches a **promote role that does not exist yet** (Phase F) and
 * `onBlocked` logs rather than raising a harness issue (Phase E). The sweep is a
 * **no-op for every plan without a `## Promote` policy**, so wiring it in is safe.
 */
import { withWorkspace } from '@restart/db-org';
import { DEFAULT_WORKSPACE_ID } from '../workspace-registry';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { parsePromotePolicy } from '../agent-tools/plans/promote-policy';
import { runWaveAdvanceTick, type WaveSweepDeps, type StartedPlan } from './wave-advance-sweep';
import type { WaveFeature, WaveForAdvance } from './waves';

const SWEEP_INTERVAL_MS = Number(process.env.PAPERCUSP_WAVE_SWEEP_MS ?? 30_000);

function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

/** The real, side-effecting dependencies. */
export function liveWaveSweepDeps(): WaveSweepDeps {
  return {
    async listStartedPlans(): Promise<StartedPlan[]> {
      return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
        const rows = (await tx`
          SELECT plan_slug, harness_slug, current_wave
            FROM harness_shared.harness_plan_status
           WHERE status = 'started'
        `) as Array<{ plan_slug: string; harness_slug: string; current_wave: string | null }>;
        return rows.map((r) => ({ slug: r.plan_slug, harnessSlug: r.harness_slug, currentWave: r.current_wave ?? null }));
      });
    },

    async getPlanWaves(slug: string): Promise<WaveForAdvance[] | null> {
      const planFile = await readPlanBySlug(slug).catch(() => null);
      if (!planFile) return null;
      const { policy } = parsePromotePolicy(planFile.parsed.raw);
      if (!policy) return null;
      return policy.waves.map((w) => ({ id: w.id, needsItems: !!w.generate }));
    },

    async getPlanFeatures(plan: StartedPlan): Promise<WaveFeature[]> {
      return withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
        const rows = (await tx`
          SELECT wave, status, attempts
            FROM harness_shared.harness_features_consolidated
           WHERE source_plan_slug = ${plan.slug}
             AND harness_slug     = ${plan.harnessSlug}
        `) as Array<{ wave: string | null; status: string | null; attempts: number | null }>;
        return rows.map((r) => ({
          wave: r.wave ?? null,
          status: r.status ?? null,
          attempts: r.attempts != null ? Number(r.attempts) : null,
        }));
      });
    },

    async setCursor(p): Promise<void> {
      await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
        await tx`
          UPDATE harness_shared.harness_plan_status
             SET current_wave = ${p.wave}, updated_at = now()
           WHERE harness_slug = ${p.harnessSlug} AND plan_slug = ${p.slug}
        `;
      });
    },

    async promoteWave(p): Promise<void> {
      // Phase F: launch the promote agent for the next wave. The harness invoke
      // is role-based; the `promote` role + its directive plumbing land in Phase
      // F. Until then this is the wiring point — it will 4xx (no such role) and
      // the tick logs + does not advance the cursor (promoteWave throws → retry).
      const url = `${operatorBase()}/api/harness/${encodeURIComponent(p.harnessSlug)}/invoke?role=promote`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan_slug: p.slug, wave: p.wave, needs_items: p.needsItems }),
      });
      if (!res.ok) throw new Error(`promote launch ${res.status} (promote role pending — Phase F)`);
    },

    async onBlocked(p): Promise<void> {
      // Phase E: raise a deterministic `harness_issues` row so the operator
      // scanner surfaces it. For now, log — issue creation is per-project/file-
      // coupled (harness-issues.ts) and lands with Phase E.
      console.warn(`[wave-advance] BLOCKED: plan ${p.slug}@${p.harnessSlug} wave "${p.wave}" — fix or deprecate the failing feature (Phase E: raise an issue here)`);
    },

    log: (msg) => console.log(msg),
  };
}

// ── Lifecycle (mirror harness-status-sweep) ─────────────────────────────────

interface SweepState {
  timer: ReturnType<typeof setInterval>;
  stopped: boolean;
}
type _G = { __waveAdvanceSweep?: SweepState };
const _g = globalThis as unknown as _G;

/** Idempotent. Starts the wave-advance sweep on first call. Wire from the same
 *  host entrypoint that starts harness-status-sweep. */
export function ensureWaveAdvanceSweep(): SweepState {
  if (_g.__waveAdvanceSweep) return _g.__waveAdvanceSweep;
  const deps = liveWaveSweepDeps();
  const tick = () =>
    runWaveAdvanceTick(deps).catch((e) => console.warn('[wave-advance] tick failed:', e?.message ?? e));

  const state: SweepState = {
    timer: setInterval(() => void tick(), SWEEP_INTERVAL_MS),
    stopped: false,
  };
  void tick(); // first tick immediately

  const shutdown = () => stopWaveAdvanceSweep();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  _g.__waveAdvanceSweep = state;
  return state;
}

export function stopWaveAdvanceSweep(): void {
  const state = _g.__waveAdvanceSweep;
  if (!state || state.stopped) return;
  state.stopped = true;
  clearInterval(state.timer);
  _g.__waveAdvanceSweep = undefined;
}
