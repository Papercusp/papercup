/** Agent retention pins use the existing release-retention lease store.
 * The unchanged TSV schema protects pins in both shell and TypeScript deleters;
 * owner/reason metadata lives in the opaque tag, not a parallel pin database.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Sql } from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import type { listPresence } from '../agent-tools/coordination/presence';
import type { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { AGENT_MAX_AGE_HOURS } from './retention-policy';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { createRetentionPin, withRetentionPinProtection,
  type RetentionPin } from '../../../../scripts/lib/retention-pins.mjs';
export { createRetentionPin, removeRetentionPin, readRetentionPins, readRetentionPinsAsync, withRetentionPinProtection,
  retentionPinProtectsPath as pinProtectsPath } from '../../../../scripts/lib/retention-pins.mjs';
export type { RetentionPin } from '../../../../scripts/lib/retention-pins.mjs';

/** The final protection read and deletion share storage:pin's cross-process mutex. */
export async function withUnpinnedPath(path: string, remove: () => boolean | Promise<boolean>,
  options: Parameters<typeof withRetentionPinProtection>[1] = {}): Promise<boolean> {
  return withRetentionPinProtection((isPinned) => isPinned(path) ? false : remove(), options);
}

export interface WorkItemEvidenceReference {
  work_item_id: string;
  harness_slug: string;
  evidence_ref: string;
}

/** Reuse immutable bindings, work-item custody and canonical session liveness.
 * Losing custody or authority stops renewal, never shortens an existing lease.
 * An unreadable liveness leg aborts reclaim rather than authorizing deletion. */
export async function readOpenWorkItemEvidenceReferences(sql: Sql, workspaceId: string, options: {
  nowMs?: number; listPresence?: typeof listPresence; resolveSessionStates?: typeof resolveSessionStates;
} = {}): Promise<WorkItemEvidenceReference[]> {
  const candidates = await sql<Array<WorkItemEvidenceReference & { taken_by: string | null }>>`
    SELECT DISTINCT b.work_item_id, b.harness_slug, b.evidence_ref, w.taken_by
      FROM harness_shared.spec_evidence_bindings b
      JOIN harness_shared.work_items w
        ON w.workspace_id = ANY(${[...new Set([workspaceId, DEFAULT_COORD_WORKSPACE])]}::text[])
       AND w.harness_slug = b.harness_slug AND w.feature_id = b.work_item_id
     WHERE b.workspace_id = ${workspaceId}
       AND b.retracted_at IS NULL
       AND b.evidence_ref LIKE 'docs/evidence/%.json'
       AND NOT (w.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
       AND w.taken_by IS NOT NULL`;
  const ownerIds = [...new Set(candidates.map(ref => ref.taken_by).filter((id): id is string => !!id))];
  if (!ownerIds.length) return [];
  const readPresence = options.listPresence ?? (await import('../agent-tools/coordination/presence')).listPresence;
  const { classifyReadActionability, resolveSessionStates: resolveStates } = await import('../agent-tools/coordination/liveness-oracle');
  const presence = (await readPresence({ ownerIds })).filter(row => !row.revoked);
  const states = await (options.resolveSessionStates ?? resolveStates)(presence.map(row => ({
    ownerId: row.ownerId, heartbeatAt: row.heartbeatAt, stale: row.stale, host: row.host,
    pid: row.pid, source: row.source, agentRole: row.agentRole, claimsHeld: true,
  })), { nowMs: options.nowMs });
  const authorized = new Set<string>();
  for (const row of presence) {
    const actionability = classifyReadActionability(states.get(row.ownerId)?.sessionState);
    if (actionability === 'unknown') throw new Error(`evidence retention: consumer liveness unknown for ${row.ownerId}`);
    if (actionability === 'actionable') authorized.add(row.ownerId);
  }
  const references = new Map<string, WorkItemEvidenceReference>();
  for (const { taken_by, ...ref } of candidates) {
    if (taken_by && authorized.has(taken_by)) {
      references.set(`${ref.harness_slug}\0${ref.work_item_id}\0${ref.evidence_ref}`, ref);
    }
  }
  return [...references.values()];
}

/** Called only while holding papercusp-disk-retention, before selecting effects.
 * Explicit retainedEvidence roots reuse the existing TSV pin store, so native
 * cleaners honour the same protection. No checkpoint/prose path guessing. */
export async function renewWorkItemEvidencePins(references: readonly WorkItemEvidenceReference[], options: {
  repositories: ReadonlyMap<string, string>; home?: string; dir?: string; nowMs?: number; dryRun?: boolean;
}): Promise<{ pins: RetentionPin[]; missing: Array<{ workItemId: string; evidenceRef: string; path: string }> }> {
  const nowMs = options.nowMs ?? Date.now();
  const pins: RetentionPin[] = [], missing: Array<{ workItemId: string; evidenceRef: string; path: string }> = [];
  const home = options.home ?? homedir();
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
  };
  for (const ref of references) {
    const repository = options.repositories.get(ref.harness_slug);
    if (!repository) throw new Error(`evidence retention: unregistered harness ${ref.harness_slug}`);
    if (!/^docs\/evidence\/.+\.json$/.test(ref.evidence_ref) || ref.evidence_ref.split('/').some(part => part === '..' || part === '.') || ref.evidence_ref.includes('\\')) {
      throw new Error(`evidence retention: unsafe receipt ${ref.evidence_ref}`);
    }
    const receipt = resolve(repository, ref.evidence_ref);
    let document: { retainedEvidence?: { root?: unknown; pathBase?: unknown } };
    try {
      if (!inside(await realpath(repository), await realpath(receipt))) throw new Error('receipt escapes repository');
      document = JSON.parse(await readFile(receipt, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push({ workItemId: ref.work_item_id, evidenceRef: ref.evidence_ref, path: receipt });
        continue;
      }
      throw error;
    }
    const retained = document.retainedEvidence;
    if (!retained || typeof retained.root !== 'string') continue;
    const base = typeof retained.pathBase === 'string' && retained.pathBase.startsWith('Operating account home directory')
      ? home : typeof retained.pathBase === 'string' && /^(Repository root|Staging checkout|Repository checkout)/i.test(retained.pathBase)
        ? repository : undefined;
    if (!isAbsolute(retained.root) && !base) throw new Error(`evidence retention: ambiguous root base in ${ref.evidence_ref}`);
    const path = resolve(base ?? repository, retained.root);
    if (![home, repository].some(root => ['evidence', 'test-evidence', 'artifacts', 'release-artifacts'].some(kind => inside(join(root, '.papercusp', kind), path)))) {
      throw new Error(`evidence retention: root outside agent evidence in ${ref.evidence_ref}`);
    }
    const digest = createHash('sha256').update(`${ref.harness_slug}\0${ref.work_item_id}\0${path}`).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    try {
      pins.push(createRetentionPin({ path, owner: `work-item:${ref.work_item_id}`, reason: `Open work-item evidence: ${ref.evidence_ref}`,
        expiresAt: new Date(nowMs + AGENT_MAX_AGE_HOURS * 3_600_000).toISOString() }, { dir: options.dir, nowMs, id, dryRun: options.dryRun }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push({ workItemId: ref.work_item_id, evidenceRef: ref.evidence_ref, path });
      else throw error;
    }
  }
  return { pins, missing };
}

/** Intake and reclaim use the same lock order: retention mutex, then database.
 * A retained root must still exist before the binding can be accepted. A pin
 * made for a refused binding is harmless and expires without renewal. */
export async function withWorkItemEvidenceRetention<T>(reference: WorkItemEvidenceReference,
  options: Parameters<typeof renewWorkItemEvidencePins>[1], accept: () => Promise<T>): Promise<T> {
  return withFsMutex('papercusp-disk-retention', async () => {
    const protection = await renewWorkItemEvidencePins([reference], options);
    if (protection.missing.length) throw new Error(`evidence retention: missing declared evidence ${protection.missing[0]!.path}`);
    return accept();
  });
}
