/**
 * acceptance-runtime-wait-guard.ts — challenge a deploy wait the caller's acceptance
 * bars do not need (acceptance-runtime-plane-not-main-2026-09-23 P-003).
 *
 * The psu-pty implementer armed `events:await release:deployed` to finish acceptance on
 * bars whose code runs in bg-host — code a :3070 deploy never carries. The wait was
 * pure latency. This guard notices the SHAPE of that wait (a release-deploy event key,
 * or a loop goal that names main / :3070 / a deploy) and, when the plan the caller holds
 * has live/deployed bars measured on a runtime OTHER than the release operator, attaches
 * an advisory naming those runtimes.
 *
 * ADVISORY ONLY. It never refuses or alters the wait: a caller may genuinely need the
 * release operator (a release-operator bar, final shipment), and a guard that blocked
 * would teach agents to route around it. It is also silent when every held live bar
 * really is measured on the release operator.
 */
import { resolveBarEvidenceRuntime, type BarEvidenceRuntime } from './acceptance-bar-evidence-runtime';
import type { ServingRuntimeId } from './serving-runtimes';

/** Event keys whose only meaning is "the release operator received new code". */
export function isDeployWaitEvent(key: string | null | undefined): boolean {
  if (!key) return false;
  return /^(release:deployed|release:deploy-|deploy:await)/.test(key.trim());
}

/**
 * A loop goal that is waiting on the release plane. Deliberately narrow — "main" alone is
 * an ordinary English word — so it only matches the release-plane phrasings agents write.
 */
export function goalNamesDeployWait(goal: string | null | undefined): boolean {
  if (!goal) return false;
  return (
    /\bgreen[- ]main\b/i.test(goal) ||
    /:3070\b/.test(goal) ||
    /\brelease:deployed\b/i.test(goal) ||
    /\b(wait(ing)?|until|once|after|blocked)\b[^.\n]{0,40}\b(main|deploy(ed|s)?|deployment)\b/i.test(goal) ||
    /\b(reach(es|ed)?|land(s|ed)? (on|in)|promot(e|es|ed) to|on) main\b/i.test(goal)
  );
}

export interface HeldLiveBar {
  planSlug: string;
  barKey: string;
  evidencePlane: 'deployed' | 'live';
  resolution: BarEvidenceRuntime;
}

/** Non-null iff some held live/deployed bar is measured somewhere other than :3070. */
export function buildAcceptancePlaneAdvisory(bars: ReadonlyArray<HeldLiveBar>): string | null {
  const elsewhere = bars.filter(
    (b) => b.resolution.runtime !== null && b.resolution.runtime !== 'release-operator',
  );
  if (elsewhere.length === 0) return null;
  const byRuntime = new Map<ServingRuntimeId, string[]>();
  for (const bar of elsewhere) {
    const runtime = bar.resolution.runtime!;
    const list = byRuntime.get(runtime) ?? [];
    list.push(`${bar.planSlug}#${bar.barKey}${bar.resolution.source === 'inferred' ? ' (inferred)' : ''}`);
    byRuntime.set(runtime, list);
  }
  const where = [...byRuntime.entries()].map(([runtime, keys]) => `${runtime}: ${keys.join(', ')}`).join('; ');
  const releaseBars = bars.filter((b) => b.resolution.runtime === 'release-operator').map((b) => `${b.planSlug}#${b.barKey}`);
  return (
    `ACCEPTANCE-PLANE ADVISORY: this wait is on the release operator (:3070 / green main), but the live/deployed ` +
    `acceptance bars you hold are measured on other runtimes — ${where}. Measure those NOW on their runtime ` +
    `(dev:pipeline_position { path } → servingRuntimes names each runtime's build and whether it runs your change); ` +
    `a :3070 deploy does not change code they execute. ` +
    (releaseBars.length
      ? `Only ${releaseBars.join(', ')} genuinely need the release operator. `
      : 'None of your held bars needs the release operator. ') +
    'Registered anyway — this is advice, not a refusal.'
  );
}

export interface WaitGuardDeps {
  /** The plan slugs the caller is working (presence currentPlanSlug + held plan work). */
  heldPlanSlugs: (ownerId: string) => Promise<string[]>;
  /** The live acceptance criteria of a plan (null when it has none). */
  acceptanceCriteria: (planSlug: string) => Promise<ReadonlyArray<{
    barKey?: string;
    key: string;
    evidencePlane?: 'tree' | 'deployed' | 'live';
    evidenceRuntime?: ServingRuntimeId;
    model?: string;
    method?: string;
    driftMarkers?: string;
    replication?: string;
  }> | null>;
}

export async function loadHeldLiveBars(ownerId: string, deps: WaitGuardDeps): Promise<HeldLiveBar[]> {
  const slugs = [...new Set(await deps.heldPlanSlugs(ownerId))].slice(0, 5);
  const out: HeldLiveBar[] = [];
  for (const planSlug of slugs) {
    const criteria = await deps.acceptanceCriteria(planSlug).catch(() => null);
    for (const c of criteria ?? []) {
      if (c.evidencePlane !== 'live' && c.evidencePlane !== 'deployed') continue;
      out.push({
        planSlug,
        barKey: c.barKey ?? c.key,
        evidencePlane: c.evidencePlane,
        resolution: resolveBarEvidenceRuntime(c),
      });
    }
  }
  return out;
}

async function realHeldPlanSlugs(ownerId: string): Promise<string[]> {
  const { getPresence } = await import('./agent-tools/coordination/presence');
  const presence = await getPresence(ownerId).catch(() => null);
  return presence?.currentPlanSlug ? [presence.currentPlanSlug] : [];
}

async function realAcceptanceCriteria(planSlug: string) {
  const { getAcceptanceRubricForPlan } = await import('./rubrics');
  const rubric = await getAcceptanceRubricForPlan(planSlug).catch(() => null);
  return rubric?.criteria ?? null;
}

export const REAL_WAIT_GUARD_DEPS: WaitGuardDeps = {
  heldPlanSlugs: realHeldPlanSlugs,
  acceptanceCriteria: realAcceptanceCriteria,
};

/**
 * The one call both wait surfaces make. Cheap when the wait is not deploy-shaped (no I/O),
 * and it never throws — a failed read degrades to "no advisory", never to a refused wait.
 */
export async function acceptancePlaneAdvisoryForWait(
  input: { ownerId: string | null | undefined; event?: string | null; goal?: string | null },
  deps: WaitGuardDeps = REAL_WAIT_GUARD_DEPS,
): Promise<string | null> {
  if (!input.ownerId) return null;
  if (!isDeployWaitEvent(input.event) && !goalNamesDeployWait(input.goal)) return null;
  try {
    return buildAcceptancePlaneAdvisory(await loadHeldLiveBars(input.ownerId, deps));
  } catch {
    return null;
  }
}
