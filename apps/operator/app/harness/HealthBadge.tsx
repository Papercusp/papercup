'use client';

import { memo, useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';

import { useWorkspaceId } from '@/lib/use-workspace-id';
import { Tooltip } from './Tooltip';
import { Heart } from 'lucide-react';
import { StatCard } from '@papercusp/ui-primitives';

// Derived shape — same fields HealthBadge always rendered, just assembled
// from multiple Zero queries instead of one /health REST aggregate.
interface HealthCheck { name: string; ok: boolean; detail?: string }
interface DerivedHealth {
  ok: boolean;
  alive: boolean;
  escalated: boolean;
  features: { total: number; passed: number; failing: number; inProgress: number; blocked: number };
  lastRunAgeSeconds: number | null;
  ghostRate: number;
  checks: HealthCheck[];
}

interface Props { slug: string }

// Row shapes for queries used here. Loosely typed because the fields we
// pluck are stable.
type Lane = { phase: string };
type Escalation = { escalation?: string | null };
type Decision = { isGhost: boolean };
type Checkpoint = { granted: boolean };
type Smoke = { status: string };
type FeatureRow = { status: string };
type AgentRun = { harnessSlug?: string; ts: number };

function HealthBadgeInner({ slug }: Props) {
  const workspaceId = useWorkspaceId();

  // Process liveness via harness_lanes (the PID-swept live lane tracker) — a
  // staging lane row means an agent process is live in staging. Replaces the
  // retired harness_phases mirror (fs-watcher-retirement step 5). NB: this is
  // "an agent is actively running in staging" (vs the old "driver process
  // exists") — equivalent for the health dot; the lane sweep drops dead PIDs.
  const lanesQ = useSyncQuery<Lane>({
    queryName: 'harnessLanes.byHarness',
    args: { harnessSlug: slug, workspaceId, phase: 'staging' },
  });

  // Escalation: harnessEscalations.byHarness (staging) — escalation column
  // is non-empty when escalation.md exists.
  const escalationsQ = useSyncQuery<Escalation>({
    queryName: 'harnessEscalations.byHarness',
    args: { harnessSlug: slug, phase: 'staging' },
  });

  // Ghost rate: harnessDecisions.byHarness (already capped at 200 entries
  // server-side; matches the /health endpoint's tailFile-128KB window
  // closely enough for a verdict).
  const decisionsQ = useSyncQuery<Decision>({
    queryName: 'harnessDecisions.byHarness',
    args: { harnessSlug: slug },
  });

  // Pending checkpoints: harnessCheckpoints.byHarness, count where granted=false.
  const checkpointsQ = useSyncQuery<Checkpoint>({
    queryName: 'harnessCheckpoints.byHarness',
    args: { harnessSlug: slug },
  });

  // Smoke test: harnessSmokeTest.byHarness (single-row aggregate).
  const smokeQ = useSyncQuery<Smoke>({
    queryName: 'harnessSmokeTest.byHarness',
    args: { harnessSlug: slug },
  });

  // Features for THIS slug. The /health endpoint reads parseFeatures(project)
  // Slug-agnostic via featuresConsolidated.bySlug (post-029).
  const featuresQ = useSyncQuery<FeatureRow>({
    queryName: 'featuresConsolidated.bySlug',
    args: { harnessSlug: slug },
  });
  const myFeatures = featuresQ.data ?? [];

  // Most-recent agent run via slug-agnostic consolidated query.
  const runsQ = useSyncQuery<AgentRun>({
    queryName: 'agentRunsConsolidated.recent',
    args: { harnessSlug: slug },
  });
  const lastRunMs = useMemo(() => {
    let max = 0;
    for (const r of runsQ.data ?? []) {
      if (r.ts > max) max = r.ts;
    }
    return max;
  }, [runsQ.data]);

  const data = useMemo<DerivedHealth | null>(() => {
    // Wait for the small queries to land before producing a verdict.
    // (featuresOrg/agentRunsOrg can be empty without blocking the badge.)
    if (lanesQ.loading) return null;

    // alive = an agent process is live in staging (harness_lanes is PID-swept,
    // so a present row implies a live pid).
    const alive = (lanesQ.data ?? []).length > 0;
    const escalation = escalationsQ.data?.[0]?.escalation;
    const escalated = typeof escalation === 'string' && escalation.length > 0;

    const total = myFeatures.length;
    const passed = myFeatures.filter((f) => f.status === 'passed').length;
    const failing = myFeatures.filter((f) => f.status === 'failing').length;
    const inProgress = myFeatures.filter(
      (f) => f.status === 'in_progress' || f.status === 'validating',
    ).length;
    const blocked = myFeatures.filter((f) => f.status === 'blocked').length;

    const decisions = decisionsQ.data ?? [];
    const ghosts = decisions.filter((d) => d.isGhost).length;
    const ghostRate = decisions.length > 0 ? ghosts / decisions.length : 0;

    const pendingCheckpoints = (checkpointsQ.data ?? []).filter((c) => !c.granted).length;
    const smokeFail = smokeQ.data?.[0]?.status === 'fail';

    const lastRunAgeSeconds = lastRunMs ? Math.floor((Date.now() - lastRunMs) / 1000) : null;

    const checks: HealthCheck[] = [
      { name: 'features_present',    ok: total > 0 },
      { name: 'not_escalated',       ok: !escalated, detail: escalated ? 'see escalation.md' : undefined },
      { name: 'no_pending_checkpoints', ok: pendingCheckpoints === 0,
        detail: pendingCheckpoints > 0 ? `${pendingCheckpoints} awaiting grant` : undefined },
      { name: 'smoke_passing',       ok: !smokeFail, detail: smokeFail ? 'see smoke-failure.md' : undefined },
      { name: 'parser_clean',        ok: ghostRate < 0.05,
        detail: ghostRate >= 0.05 ? `${(ghostRate * 100).toFixed(1)}% ghost decisions` : undefined },
    ];
    const ok = checks.every((c) => c.ok);

    return {
      ok,
      alive,
      escalated,
      features: { total, passed, failing, inProgress, blocked },
      lastRunAgeSeconds,
      ghostRate,
      checks,
    };
  }, [
    lanesQ.data, lanesQ.loading,
    escalationsQ.data,
    decisionsQ.data,
    checkpointsQ.data,
    smokeQ.data,
    myFeatures,
    lastRunMs,
  ]);

  if (!data) {
    return (
      <Tooltip label="Loading health…">
        <div>
          <StatCard label="health" value="…" icon={<Heart size={13} />} />
        </div>
      </Tooltip>
    );
  }

  const passed = data.checks.filter((c) => c.ok).length;
  const total = data.checks.length;
  const tone: 'good' | 'warn' | 'bad' = data.ok
    ? 'good'
    : passed >= Math.ceil(total * 0.7) ? 'warn' : 'bad';

  const tooltip = [
    `health checks: ${passed}/${total} passing`,
    ...data.checks.filter((c) => !c.ok).map((c) => `• ${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
  ].join('\n');

  return (
    <Tooltip label={tooltip}>
      <div>
        <StatCard
          label="health"
          value={`${passed}/${total}`}
          tone={tone}
          icon={<Heart size={13} />}
        />
      </div>
    </Tooltip>
  );
}

export const HealthBadge = memo(HealthBadgeInner);
export default HealthBadge;
