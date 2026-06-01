/**
 * Wave-advance sweep — LIVE adapters + lifecycle (P-009b-ii).
 *
 * The impure half of the sweep: the real `WaveSweepDeps` (PG queries, plan read,
 * promote launch) + the periodic `setInterval` lifecycle, mirroring
 * `harness-status-sweep.ts`. The pure orchestration + decision live in
 * `wave-advance-sweep.ts` / `waves.ts` and are unit-tested there.
 *
 * Host-verified 2026-05-31 (promote-policy-and-waves): the sweep waits while a
 * wave is in-progress and, on drain, invokes the `promote` role for the next wave
 * via `/harness/:slug/invoke?role=promote` — passing the wave as `body.extra`
 * (`PLAN_SLUG`/`WAVE`/`NEEDS_ITEMS`, the format spawn.ts forwards as the agent's
 * Runtime context). `onBlocked` raises a deterministic `(plan, wave)`-keyed
 * `harness_issues` row (`source='system'`). Workspace resolves via
 * `activeWorkspaceId()` — consistent with `harness-status-sweep` and the harness
 * routes (`resolveProject`/`features/import`). The sweep is a **no-op for every
 * plan without a `## Promote` policy**, so it is safe to leave running.
 */
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { readPlanBySlug } from '../agent-tools/plans/source';
import { parsePromotePolicy } from '../agent-tools/plans/promote-policy';
import { resolveProject } from '../harness-core';
import { loadIssuesOrSeed, saveIssues } from '../harness-issues';
import { runWaveAdvanceTick, type WaveSweepDeps, type StartedPlan } from './wave-advance-sweep';
import type { WaveFeature, WaveForAdvance } from './waves';
import { loopbackFetch } from '../loopback-fetch';

const SWEEP_INTERVAL_MS = Number(process.env.PAPERCUSP_WAVE_SWEEP_MS ?? 30_000);

function operatorBase(): string {
  const port = process.env.PORT ?? '3055';
  return process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
}

/** The real, side-effecting dependencies. */
export function liveWaveSweepDeps(): WaveSweepDeps {
  return {
    async listStartedPlans(): Promise<StartedPlan[]> {
      return withWorkspace(activeWorkspaceId(), async (tx) => {
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
      return withWorkspace(activeWorkspaceId(), async (tx) => {
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
      await withWorkspace(activeWorkspaceId(), async (tx) => {
        await tx`
          UPDATE harness_shared.harness_plan_status
             SET current_wave = ${p.wave}, updated_at = now()
           WHERE harness_slug = ${p.harnessSlug} AND plan_slug = ${p.slug}
        `;
      });
    },

    async promoteWave(p): Promise<void> {
      // Launch the promote agent for the next wave via the role-based harness
      // invoke (`/harness/:slug/invoke?role=promote`, spawn.ts). That route reads
      // `body.extra` (a `KEY=value` string[]) and forwards it as the agent's
      // EXTRAS / Runtime-context lines — so the wave must be passed THAT way, not
      // as top-level JSON keys (the promote.md prompt reads PLAN_SLUG/WAVE/
      // NEEDS_ITEMS from Runtime context). promoteWave throws on non-OK → the tick
      // does NOT advance the cursor → it retries next tick.
      const url = `${operatorBase()}/api/harness/${encodeURIComponent(p.harnessSlug)}/invoke?role=promote`;
      const res = await loopbackFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          extra: [`PLAN_SLUG=${p.slug}`, `WAVE=${p.wave}`, `NEEDS_ITEMS=${p.needsItems}`],
        }),
      });
      if (!res.ok) throw new Error(`promote launch ${res.status} for ${p.harnessSlug} wave "${p.wave}"`);
    },

    async onBlocked(p): Promise<void> {
      // Phase E: raise a deterministic `harness_issues` row (via the FS-canonical
      // issues store, which mirrors to PG) so the operator scanner surfaces the
      // blocked wave. Keyed by (plan, wave) → idempotent: re-blocking updates the
      // same row instead of duplicating. source='system' (sweep-detected).
      const project = await resolveProject(p.harnessSlug).catch(() => null);
      if (!project) {
        console.warn(`[wave-advance] BLOCKED: plan ${p.slug}@${p.harnessSlug} wave "${p.wave}" — harness not resolvable in the active workspace, cannot raise issue`);
        return;
      }
      const issueId = `I-WAVE-${p.slug}-${p.wave}`;
      const file = loadIssuesOrSeed(project);
      const existing = file.issues.find((i) => i.id === issueId);
      if (existing) {
        // Already raised. Reopen only if a human had closed it while the wave is
        // still blocked; otherwise leave it (no duplicate, no churn).
        if (existing.status === 'closed' || existing.status === 'wontfix') {
          existing.status = 'open';
          await saveIssues(project, file);
        }
        return;
      }
      file.issues.push({
        id: issueId,
        title: `Wave "${p.wave}" blocked in ${p.slug}`,
        severity: 'major',
        source: 'system',
        foundAt: new Date().toISOString(),
        foundDuring: p.slug,
        status: 'open',
        evidence: `The wave-advance sweep cannot advance plan "${p.slug}" past wave "${p.wave}" in harness "${p.harnessSlug}": a feature in this wave is failing or stuck (not terminal), so the wave never drains and the next wave will not promote.`,
        suggestedFix: `Resolve the failing feature(s) in wave "${p.wave}", or mark them deprecated if they are intentionally skipped — either lets the wave drain and the next wave promote.`,
        attempts: 0,
        notes: [],
      });
      await saveIssues(project, file);
      console.warn(`[wave-advance] BLOCKED: raised issue ${issueId} — plan ${p.slug}@${p.harnessSlug} wave "${p.wave}"`);
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
