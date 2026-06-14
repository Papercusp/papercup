/**
 * getSpawnHandoffContext — the PREDECESSOR-HANDOFF half of the spawn/wake
 * hydration seam (directed-wake-honesty-and-spawn-handoff-2026-06-14 P-010 +
 * P-022). Gathers, for a spawning/waking agent working `featureId`:
 *   - predecessorSummaries: its direct blocked_by upstreams' completion/state
 *     (the work it depends on, with their handoff content),
 *   - messages: feature-scoped handoffs addressed to it (`to_feature_id`),
 *   - planSlice: the source plan's Now + recent decisions (the existing
 *     interactive hydration, brought to the autonomous path — plan D-003).
 *
 * PROVENANCE (P-022 — the security half, my trust-author wheelhouse): each
 * source's content is classified by its ORIGIN via the G2 trust gate
 * (work-items-admission). Local / auditor-admitted / trusted-author content is
 * returned RAW (trusted brief context); REMOTE + un-admitted content is wrapped
 * in the G3 untrusted-peer-content frame (`wrapUntrusted`) so a spawned agent
 * treats it as DATA, never as instructions — it must NEVER be injected raw as
 * trusted brief. Ties to shared-hive-trust-admission-2026-06-14 (G2/G3).
 *
 * CONTRACT (locked with su-7b271, the P-021 seam integrator): returns STRUCTURED
 * parts; the seam (assembleSpawnHydration) bounds across all halves + renders
 * the `## Handoff` section. Each `entry.body` is ALREADY provenance-framed and
 * pre-capped to a per-entry budget, so the seam bounds by DROPPING WHOLE ENTRIES
 * — never by truncating a body mid-string (a mid-frame cut would sever an
 * untrusted frame's closing tag = an injection hole). The gather is fail-soft
 * per source: a throwing source degrades to [] / null, never the whole seam.
 */
import { getOrgPg } from '@papercusp/db-org';
import { wrapUntrusted } from '@papercusp/orchestrator/prompt-build';
import { getFeatureBlockers } from './dbos/feature-blockers-edges';
import { getWorkItem } from './work-items';
import { isAutoPickable, loadTrustedGithubUserIds } from './work-items-admission';
import { getPlanContextBySlug } from './plan-context-for-feature';
import { DEFAULT_WORKSPACE_ID } from './workspace-id-constant';
// Contract types are owned by the P-021 seam (su-7b271, D-004) — import them as
// the single source of truth so producer + consumer never drift. Re-exported
// here for convenience (callers may import from either module).
import type { HandoffEntry, SpawnHandoffContext } from './fleet/spawn-hydration';
export type { HandoffEntry, SpawnHandoffContext };

/** A direct-upstream count cap (P-013: "direct upstreams only"). */
const MAX_PREDECESSORS = 8;
/** Feature-scoped handoff messages cap. */
const MAX_MESSAGES = 12;
/** Per-entry body budget (chars) — capped BEFORE framing so an untrusted frame
 *  is never split when the seam drops/bounds entries. */
const PER_ENTRY_BODY_CAP = 1200;

/** The pre-classification shape the pure framer consumes (decoupled from PG). */
export interface RawHandoffEntry {
  kind: 'message' | 'completion';
  fromFeatureId?: string;
  author?: string;
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
  rawBody: string;
  ts: number;
}

function capBody(body: string, cap: number): { text: string; truncated: boolean } {
  const b = body ?? '';
  if (b.length <= cap) return { text: b, truncated: false };
  return { text: `${b.slice(0, cap)}\n…[truncated]`, truncated: true };
}

/**
 * PURE provenance-classify + frame (P-022 core, unit-testable without PG): for
 * each raw entry, decide trusted via the G2 gate; cap the body; then frame —
 * untrusted bodies are wrapped in `wrapUntrusted` (cap-then-wrap so the frame is
 * intact). `wrap` is injectable for tests; defaults to the canonical G3 frame.
 */
export function frameHandoffEntries(
  raw: RawHandoffEntry[],
  trustedGithubUserIds: ReadonlySet<number>,
  opts?: { perEntryCap?: number; wrap?: (s: string) => string },
): { entries: HandoffEntry[]; truncated: boolean } {
  const cap = opts?.perEntryCap ?? PER_ENTRY_BODY_CAP;
  const wrap = opts?.wrap ?? wrapUntrusted;
  let truncated = false;
  const entries: HandoffEntry[] = [];
  for (const r of raw) {
    const trusted = isAutoPickable(r.origin, r.auditVerdict, r.verifiedAuthorGithubUserId, trustedGithubUserIds);
    const capped = capBody(r.rawBody, cap);
    if (capped.truncated) truncated = true;
    // cap BEFORE wrap — wrapping a truncated body keeps the frame's closing tag.
    const body = trusted ? capped.text : wrap(capped.text);
    entries.push({
      kind: r.kind,
      ...(r.fromFeatureId ? { fromFeatureId: r.fromFeatureId } : {}),
      ...(r.author ? { author: r.author } : {}),
      origin: r.origin === 'remote' ? 'remote' : 'local',
      trusted,
      body,
      ts: r.ts,
    });
  }
  return { entries, truncated };
}

interface FeatureMsgRow {
  from_slug: string | null;
  from_feature_id: string | null;
  kind: string | null;
  subject: string | null;
  body: string | null;
  created_at: unknown;
}

function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Resolve a source feature's provenance triple (origin/audit/verified) for
 *  classification. A null/absent feature ⇒ treated as local (no remote risk). */
async function provenanceOf(
  featureId: string | null | undefined,
  harness: string,
): Promise<{ origin: string | null; auditVerdict: string | null; verifiedAuthorGithubUserId: number | null; author?: string }> {
  if (!featureId) return { origin: 'local', auditVerdict: null, verifiedAuthorGithubUserId: null };
  const wi = await getWorkItem(featureId, harness).catch(() => null);
  if (!wi) return { origin: 'local', auditVerdict: null, verifiedAuthorGithubUserId: null };
  return {
    origin: wi.origin,
    auditVerdict: wi.auditVerdict,
    verifiedAuthorGithubUserId: wi.verifiedAuthorGithubUserId,
    ...(wi.assignee ? { author: wi.assignee } : {}),
  };
}

/**
 * Gather the predecessor handoff context for a spawning/waking agent. Best-effort
 * + provenance-framed per the contract above. Never throws.
 */
export async function getSpawnHandoffContext(opts: {
  harness: string;
  featureId: string;
  planSlug?: string;
  workspaceId?: string;
}): Promise<SpawnHandoffContext> {
  const { harness, featureId } = opts;
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const trustedSet = await loadTrustedGithubUserIds(workspaceId).catch(() => new Set<number>());

  let truncated = false;

  // ── predecessorSummaries: direct blocked_by upstreams ─────────────────────
  let predecessorSummaries: HandoffEntry[] = [];
  try {
    const blockers = (await getFeatureBlockers(harness)).get(featureId) ?? [];
    const raw: RawHandoffEntry[] = [];
    for (const predId of blockers.slice(0, MAX_PREDECESSORS)) {
      const wi = await getWorkItem(predId, harness).catch(() => null);
      if (!wi) continue;
      const summary = (wi.summary ?? '').trim();
      const body = `${predId} [${wi.state}] ${(wi.title ?? '').trim()}${summary ? `\n${summary}` : ''}`;
      raw.push({
        kind: 'completion',
        fromFeatureId: predId,
        ...(wi.assignee ? { author: wi.assignee } : {}),
        origin: wi.origin,
        auditVerdict: wi.auditVerdict,
        verifiedAuthorGithubUserId: wi.verifiedAuthorGithubUserId,
        rawBody: body,
        ts: 0,
      });
    }
    const framed = frameHandoffEntries(raw, trustedSet);
    predecessorSummaries = framed.entries;
    truncated = truncated || framed.truncated;
  } catch {
    predecessorSummaries = [];
  }

  // ── messages: feature-scoped handoffs addressed to this feature ───────────
  let messages: HandoffEntry[] = [];
  try {
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT from_slug, from_feature_id, kind, subject, body, created_at
         FROM harness_shared.messages_consolidated
        WHERE to_feature_id = $1 AND COALESCE(status, '') <> 'dismissed'
        ORDER BY created_at DESC
        LIMIT ${MAX_MESSAGES}`,
      [featureId],
    )) as unknown as FeatureMsgRow[];
    const raw: RawHandoffEntry[] = [];
    for (const m of rows) {
      const prov = await provenanceOf(m.from_feature_id, harness);
      const subject = (m.subject ?? '').trim();
      const mbody = (m.body ?? '').trim();
      const text = `[${m.kind ?? 'message'}] ${subject}${mbody ? `\n${mbody}` : ''}`;
      raw.push({
        kind: 'message',
        ...(m.from_feature_id ? { fromFeatureId: m.from_feature_id } : {}),
        ...(prov.author || m.from_slug ? { author: prov.author ?? m.from_slug ?? undefined } : {}),
        origin: prov.origin,
        auditVerdict: prov.auditVerdict,
        verifiedAuthorGithubUserId: prov.verifiedAuthorGithubUserId,
        rawBody: text,
        ts: toMs(m.created_at),
      });
    }
    const framed = frameHandoffEntries(raw, trustedSet);
    messages = framed.entries;
    truncated = truncated || framed.truncated;
  } catch {
    messages = [];
  }

  // ── planSlice: the source plan's Now + recent decisions (local/trusted) ───
  let planSlice: string | null = null;
  if (opts.planSlug) {
    planSlice = await getPlanContextBySlug(opts.planSlug).catch(() => null);
  }

  return { messages, predecessorSummaries, planSlice, truncated };
}
