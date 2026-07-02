/**
 * github-divergence — the GitHub-bridge divergence POLICY
 * (github-bridge-hive-egress-2026-07-02 P-006 / S-4, decisions D-001/D-002).
 *
 * One invariant, enforced structurally: **GitHub is never authority for a
 * bridged hive, and the bridge never force-pushes origin.** Divergence is
 * therefore always REPORTED-NOT-APPLIED: the mechanism layers (github-egress /
 * github-ingress / github-ingress-admission) refuse the unsafe move and hand
 * the residue here; this module folds those residues into ONE durable,
 * human-visible escalation row — the same `harness_escalations` idiom as
 * git-sync's conflict/content escalations, on its OWN phase
 * (`github-bridge`) so it coexists with git-sync rows and never clobbers them.
 *
 * The four signal classes and their (non-)resolution levers:
 *   - `egress-non-ff`    — origin diverged from the hive canonical ref (human
 *     push / legacy merge commit landed on GitHub). NEVER forced. Lever: the
 *     next ingress brings the origin head into the synthetic github-origin
 *     namespace and the INTEGRATOR merges it like any member head; once
 *     canonical descends from origin, egress fast-forwards cleanly.
 *   - `ingress-non-ff`   — origin REWROTE history (the synthetic namespace
 *     would rewind). FF-only by default. Lever: owner-authorized
 *     `allowNonFF` ingress (S-4) — an explicit, audited choice, never auto.
 *   - `admission-blocked`— a revoked contributor's commits (or a fail-closed
 *     admission error) sit in the origin range. The head stays visible in the
 *     namespace but the integrator must not consume it. Lever: revocation
 *     review / admission re-run.
 *   - `egress-secret-block` — the secrets gate refused to publish a ref
 *     (nothing left the machine). Lever: scrub + re-egress. Folded here for
 *     visibility because the bridge tick already composes the same results.
 *
 * Pure classification over the mechanism results; a thin injected-sql writer
 * pair for the escalation row (house seam — unit-hermetic, integration-real).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { EgressResult } from './github-egress';
import type { IngressResult } from './github-ingress';
import type { AdmissionResult } from './github-ingress-admission';

/** The bridge's own escalation phase — never shared with git-sync's rows. */
export const GITHUB_BRIDGE_ESCALATION_PHASE = 'github-bridge';
export const GITHUB_BRIDGE_ESCALATION_KIND = 'github-bridge-divergence';

export type DivergenceSignal =
  | { kind: 'egress-non-ff'; remoteRef: string; remoteSha: string | null; localSha: string; reason: string }
  | { kind: 'ingress-non-ff'; branch: string; local: string; remote: string }
  | {
      kind: 'admission-blocked';
      head: string;
      basis: 'blocked' | 'error';
      blockedAuthors: { githubUserId: number; commits: string[] }[];
      errors: string[];
    }
  | { kind: 'egress-secret-block'; remoteRef: string; findings: number; overflow: boolean };

export interface DivergenceVerdict {
  /** No signals → clear (a clean pass clears the escalation, git-sync idiom). */
  action: 'clear' | 'escalate';
  signals: DivergenceSignal[];
  /**
   * True when resolution needs an OWNER-authorized lever (non-FF ingress, a
   * revoked-contributor decision) rather than just the integrator's next merge.
   */
  needsOwner: boolean;
  /** One-line human summary (the escalation `detail`). */
  detail: string;
}

/** Fold the mechanism results into divergence signals. Pure; all inputs optional
 *  (the bridge tick may run egress-only or ingress-only phases). */
export function collectDivergenceSignals(results: {
  egress?: Pick<EgressResult, 'rejectedNonFF' | 'blockedSecrets'> | null;
  ingress?: Pick<IngressResult, 'nonFF'> | null;
  /** Admission verdicts for newly-ingressed heads, keyed by the judged head. */
  admissions?: Array<{ head: string; result: Pick<AdmissionResult, 'admit' | 'basis' | 'blockedAuthors' | 'errors'> }>;
}): DivergenceSignal[] {
  const signals: DivergenceSignal[] = [];
  for (const r of results.egress?.rejectedNonFF ?? []) {
    signals.push({ kind: 'egress-non-ff', remoteRef: r.remoteRef, remoteSha: r.remoteSha, localSha: r.localSha, reason: r.reason });
  }
  for (const b of results.egress?.blockedSecrets ?? []) {
    signals.push({ kind: 'egress-secret-block', remoteRef: b.remoteRef, findings: b.findings.length, overflow: b.overflow });
  }
  for (const n of results.ingress?.nonFF ?? []) {
    signals.push({ kind: 'ingress-non-ff', branch: n.branch, local: n.local, remote: n.remote });
  }
  for (const a of results.admissions ?? []) {
    if (a.result.admit) continue; // 'baseline'/'clean' are non-events
    signals.push({
      kind: 'admission-blocked',
      head: a.head,
      basis: a.result.basis === 'error' ? 'error' : 'blocked',
      blockedAuthors: a.result.blockedAuthors,
      errors: a.result.errors,
    });
  }
  return signals;
}

/** Classify folded signals into the verdict the escalation writer consumes. Pure. */
export function classifyDivergence(signals: DivergenceSignal[]): DivergenceVerdict {
  if (signals.length === 0) {
    return { action: 'clear', signals, needsOwner: false, detail: 'bridge clean — no divergence' };
  }
  // Owner levers: a history rewrite can only be accepted via owner-authorized
  // allowNonFF; a blocked admission needs a revocation decision. An egress
  // non-FF usually self-heals via the integrator's next merge of the ingressed
  // origin head; a secret block needs a scrub, not an owner.
  const needsOwner = signals.some((s) => s.kind === 'ingress-non-ff' || s.kind === 'admission-blocked');
  const counts = new Map<DivergenceSignal['kind'], number>();
  for (const s of signals) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts: string[] = [];
  const c = (k: DivergenceSignal['kind']): number => counts.get(k) ?? 0;
  if (c('egress-non-ff') > 0)
    parts.push(
      `${c('egress-non-ff')} canonical ref(s) diverged on origin (NOT forced — the integrator merges the ingressed origin head; egress fast-forwards once canonical descends from it)`,
    );
  if (c('ingress-non-ff') > 0)
    parts.push(
      `${c('ingress-non-ff')} origin branch(es) rewrote history (namespace NOT rewound — accepting a rewrite is the owner-authorized allowNonFF lever)`,
    );
  if (c('admission-blocked') > 0)
    parts.push(
      `${c('admission-blocked')} github-origin head(s) blocked by contribution admission (revoked author / fail-closed error — the integrator must not consume them)`,
    );
  if (c('egress-secret-block') > 0)
    parts.push(`${c('egress-secret-block')} ref(s) blocked by the secrets gate (nothing left the machine — scrub + re-egress)`);
  return {
    action: 'escalate',
    signals,
    needsOwner,
    detail: `github-bridge divergence: ${parts.join('; ')}. Origin was never force-pushed and hive canonical refs are unchanged (S-4).`,
  };
}

/**
 * Write/refresh the bridge divergence escalation for a hive — or clear it on a
 * clean pass. One row per (hiveHomeSlug, 'github-bridge'), upserted like
 * git-sync's writers; the clear targets only our own kind (strict non-clobber).
 * Never throws (best-effort, mirrors the git-sync escalation writers).
 */
export async function recordDivergenceVerdict(
  hiveHomeSlug: string,
  workspaceId: string,
  verdict: DivergenceVerdict,
  sql?: Sql,
): Promise<void> {
  try {
    const s = sql ?? getOrgPg().sql;
    if (verdict.action === 'clear') {
      await s.unsafe(
        `UPDATE harness_shared.harness_escalations
            SET escalation = NULL, mtime_ms = $2
          WHERE harness_slug = $1 AND phase = $3
            AND escalation IS NOT NULL
            AND (escalation::jsonb ->> 'kind') = $4`,
        [hiveHomeSlug, Date.now(), GITHUB_BRIDGE_ESCALATION_PHASE, GITHUB_BRIDGE_ESCALATION_KIND],
      );
      return;
    }
    const body = JSON.stringify({
      kind: GITHUB_BRIDGE_ESCALATION_KIND,
      harness_slug: hiveHomeSlug,
      needs_owner: verdict.needsOwner,
      signals: verdict.signals,
      emitted_at: Date.now(),
      detail: verdict.detail,
    });
    await s.unsafe(
      `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (harness_slug, phase)
       DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
      [hiveHomeSlug, GITHUB_BRIDGE_ESCALATION_PHASE, body, Date.now(), workspaceId],
    );
  } catch (e) {
    console.warn(
      `[github-bridge] failed to record divergence verdict (${hiveHomeSlug}): ${e instanceof Error ? e.message : e}`,
    );
  }
}
