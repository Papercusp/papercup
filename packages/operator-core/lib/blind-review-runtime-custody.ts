/**
 * Broker P-001's durable transaction boundary. This is a host-only store, not a
 * reviewer RPC. Source admission must be produced by the frozen-image census;
 * this store does not turn a caller's hashes into source admission evidence.
 * Runtime provisioning, kernel channel authentication and discovery are separate
 * adapters. No requested row, receipt alone or returned metadata grants runtime access.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';

type Sql = ReturnType<typeof getOrgPg>['sql'];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({
  workspaceId: z.string().min(1).max(200), bindingId: z.number().int().positive(),
  activationAuditSeq: z.number().int().positive(), replacementEpoch: z.number().int().nonnegative(),
  reviewerOwnerId: z.string().min(1).max(200), nativeSessionId: z.string().min(1).max(200),
  confinementFingerprint: hash,
}).strict();
const sourceSchema = z.object({
  repositoryId: z.string().min(1).max(200), sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceTreeHash: hash, sourceInputsHash: hash, censusGeneration: z.string().min(1).max(200),
  censusStatus: z.literal('admit'), sourceImageNonce: z.string().uuid(),
}).strict();
export type RuntimeReviewerIdentity = z.infer<typeof identitySchema>;
export type RuntimeSourceAdmission = z.infer<typeof sourceSchema>;
export const RUNTIME_RESOURCE_KINDS = ['managed-scope', 'process', 'listener', 'display', 'database',
  'workspace', 'profile', 'channel', 'credential', 'capture'] as const;
export type RuntimeResourceKind = typeof RUNTIME_RESOURCE_KINDS[number];
export type RuntimeLease = {
  id: string; lease_epoch: number | string; runtime_nonce: string; workspace_id: string; binding_id: number | string;
  activation_audit_seq: number; replacement_epoch: number; request_id: string; request_hash: string;
  state: 'requested' | 'allocating' | 'ready' | 'releasing' | 'released'; receipt_id: string | null;
  admission: Record<string, unknown> | null; expires_at: Date | string | null;
  revoked_at: Date | string | null;
};
export type RuntimeResourceIntent = {
  id: string; lease_id: string; kind: RuntimeResourceKind; slot: string; ownership_tag: string;
  identity: Record<string, unknown> | null;
};
export class RuntimeCustodyRefusal extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RuntimeCustodyRefusal'; }
}
function refuse(code: string): never { throw new RuntimeCustodyRefusal(code); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('non_json_fingerprint');
  return encoded;
}
export function runtimeCustodyFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/**
 * The host must re-read authority INSIDE the transaction, before returning true.
 * This mandatory port is intentionally not defaulted to trusting stored identity.
 * A production adapter must check native lifecycle, latest binding/activation and
 * authoritative confinement; the transaction protocol is independently testable.
 */
export type RuntimeAuthorityCheck = (tx: Sql, identity: RuntimeReviewerIdentity) => Promise<boolean>;
export function createRuntimeCustodyStore(deps: { sql?: Sql; checkAuthority: RuntimeAuthorityCheck }) {
  const sql = deps.sql ?? getOrgPg().sql;
  async function transaction<T>(identity: RuntimeReviewerIdentity, run: (tx: Sql) => Promise<T>, maintenance = false): Promise<T> {
    identity = identitySchema.parse(identity);
    return sql.begin(async raw => {
      const tx = raw as unknown as Sql;
      // Binding-level serialization comes before lease row locks in every path.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identity.workspaceId + ':runtime:' + identity.bindingId}, 0))`;
      // Revocation and recovery must remain possible after the native reviewer
      // ends or loses authority. Maintenance still matches the original stored
      // identity and cannot create resources or restore ready authority.
      if (!maintenance && !await deps.checkAuthority(tx, identity)) refuse('reviewer_authority_invalid');
      return run(tx);
    }) as Promise<T>;
  }
  async function locked(tx: Sql, identity: RuntimeReviewerIdentity, id: string): Promise<RuntimeLease> {
    const [row] = await tx<RuntimeLease[]>`SELECT * FROM harness_shared.blind_review_runtime_leases
      WHERE id = ${z.string().uuid().parse(id)} AND workspace_id = ${identity.workspaceId}
        AND binding_id = ${identity.bindingId} AND activation_audit_seq = ${identity.activationAuditSeq}
        AND replacement_epoch = ${identity.replacementEpoch} FOR UPDATE`;
    return row ?? refuse('lease_not_current');
  }
  async function allocated(tx: Sql, identity: RuntimeReviewerIdentity, id: string): Promise<RuntimeLease> {
    const row = await locked(tx, identity, id);
    if (!row.admission || row.admission.confinementFingerprint !== identity.confinementFingerprint ||
        row.admission.reviewerOwnerId !== identity.reviewerOwnerId ||
        row.admission.nativeSessionId !== identity.nativeSessionId) refuse('lease_identity_mismatch');
    return row;
  }
  async function assertLive(tx: Sql, leaseId: string): Promise<void> {
    const [row] = await tx<Array<{ valid: boolean }>>`SELECT expires_at > clock_timestamp()
      AND revoked_at IS NULL AS valid FROM harness_shared.blind_review_runtime_leases WHERE id = ${leaseId}`;
    if (!row?.valid) refuse('lease_expired_or_revoked');
  }
  return {
    /** Metadata only; call the source census before consumeAdmission. */
    reserve(identity: RuntimeReviewerIdentity, requestId: string, requestHash: string): Promise<RuntimeLease> {
      z.string().min(1).max(128).parse(requestId); hash.parse(requestHash);
      return transaction(identity, async tx => {
        const [old] = await tx<RuntimeLease[]>`SELECT * FROM harness_shared.blind_review_runtime_leases
          WHERE workspace_id = ${identity.workspaceId} AND binding_id = ${identity.bindingId}
            AND replacement_epoch = ${identity.replacementEpoch}
            AND activation_audit_seq = ${identity.activationAuditSeq} FOR UPDATE`;
        if (old) {
          if (old.request_id !== requestId || old.request_hash !== requestHash) refuse('allocation_request_conflict');
          return old;
        }
        const [row] = await tx<RuntimeLease[]>`INSERT INTO harness_shared.blind_review_runtime_leases
          (id, workspace_id, binding_id, activation_audit_seq, replacement_epoch, request_id, request_hash)
          VALUES (${randomUUID()}, ${identity.workspaceId}, ${identity.bindingId}, ${identity.activationAuditSeq},
            ${identity.replacementEpoch}, ${requestId}, ${requestHash}) RETURNING *`;
        return row!;
      });
    },
    /** Host census writer only. The source-image adapter must retain the same sealed handle. */
    recordAdmission(identity: RuntimeReviewerIdentity, leaseId: string, source: RuntimeSourceAdmission): Promise<string> {
      source = sourceSchema.parse(source);
      return transaction(identity, async tx => {
        const lease = await locked(tx, identity, leaseId);
        if (!['requested', 'allocating', 'ready'].includes(lease.state)) refuse('allocation_not_active');
        if (lease.state !== 'requested') await assertLive(tx, leaseId);
        const tuple = { ...identitySchema.parse(identity), ...source, leaseEpoch: String(lease.lease_epoch),
          allocationRequestId: lease.request_id, requestHash: lease.request_hash };
        const fingerprint = runtimeCustodyFingerprint(tuple);
        const [old] = await tx<Array<{ id: string; tuple_hash: string }>>`
          SELECT id, tuple_hash FROM harness_shared.blind_review_runtime_admissions
          WHERE lease_id = ${leaseId} AND workspace_id = ${identity.workspaceId} FOR UPDATE`;
        if (old) {
          if (old.tuple_hash !== fingerprint) refuse('admission_tuple_changed');
          return old.id;
        }
        if (lease.state !== 'requested') refuse('allocation_already_consumed');
        const id = randomUUID();
        await tx`INSERT INTO harness_shared.blind_review_runtime_admissions (id, workspace_id, lease_id, tuple, tuple_hash)
          VALUES (${id}, ${identity.workspaceId}, ${leaseId}, ${JSON.stringify(tuple)}::jsonb, ${fingerprint})`;
        return id;
      });
    },
    consumeAdmission(identity: RuntimeReviewerIdentity, leaseId: string, receiptId: string): Promise<RuntimeLease> {
      z.string().uuid().parse(receiptId);
      return transaction(identity, async tx => {
        const lease = await locked(tx, identity, leaseId);
        if (lease.state !== 'requested') {
          if (lease.receipt_id !== receiptId) refuse('receipt_replay');
          if (!['allocating', 'ready'].includes(lease.state)) refuse('allocation_not_active');
          await assertLive(tx, leaseId);
          return allocated(tx, identity, leaseId);
        }
        const [receipt] = await tx<Array<{ tuple: Record<string, unknown>; tuple_hash: string }>>`
          SELECT tuple, tuple_hash FROM harness_shared.blind_review_runtime_admissions
          WHERE id = ${receiptId} AND workspace_id = ${identity.workspaceId} AND lease_id = ${leaseId}
            AND consumed_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`;
        if (!receipt) refuse('admission_invalid_or_expired');
        const tuple = receipt.tuple;
        if (runtimeCustodyFingerprint(tuple) !== receipt.tuple_hash ||
            Object.entries(identitySchema.parse(identity)).some(([k, v]) => tuple[k] !== v) ||
            tuple.leaseEpoch !== String(lease.lease_epoch) || tuple.requestHash !== lease.request_hash ||
            tuple.allocationRequestId !== lease.request_id || tuple.censusStatus !== 'admit') refuse('admission_tuple_mismatch');
        await tx`UPDATE harness_shared.blind_review_runtime_admissions SET consumed_at = clock_timestamp() WHERE id = ${receiptId}`;
        const [row] = await tx<RuntimeLease[]>`UPDATE harness_shared.blind_review_runtime_leases
          SET state = 'allocating', receipt_id = ${receiptId}, admission = ${JSON.stringify(tuple)}::jsonb,
            expires_at = clock_timestamp() + interval '15 minutes', updated_at = clock_timestamp()
          WHERE id = ${leaseId} RETURNING *`;
        return row!;
      });
    },
    /** Commit the deterministic intent BEFORE performing the corresponding OS creation. */
    intendResource(identity: RuntimeReviewerIdentity, leaseId: string, kind: RuntimeResourceKind, slot: string): Promise<RuntimeResourceIntent> {
      z.enum(RUNTIME_RESOURCE_KINDS).parse(kind); z.string().regex(/^[a-z0-9-]{1,64}$/).parse(slot);
      return transaction(identity, async tx => {
        const lease = await allocated(tx, identity, leaseId);
        if (lease.state !== 'allocating' && !(lease.state === 'ready' && kind === 'capture')) refuse('allocation_not_active');
        await assertLive(tx, leaseId);
        const [{ count }] = await tx<Array<{ count: number }>>`SELECT count(*)::int AS count
          FROM harness_shared.blind_review_runtime_resources WHERE lease_id = ${leaseId}`;
        const tag = runtimeCustodyFingerprint({ leaseId, epoch: String(lease.lease_epoch), kind, slot });
        const [old] = await tx<RuntimeResourceIntent[]>`SELECT * FROM harness_shared.blind_review_runtime_resources
          WHERE lease_id = ${leaseId} AND kind = ${kind} AND slot = ${slot}`;
        if (old) return old;
        if (count >= 64) refuse('resource_inventory_full');
        const [resource] = await tx<RuntimeResourceIntent[]>`INSERT INTO harness_shared.blind_review_runtime_resources
          (id, workspace_id, lease_id, kind, slot, ownership_tag)
          VALUES (${randomUUID()}, ${identity.workspaceId}, ${leaseId}, ${kind}, ${slot}, ${tag}) RETURNING *`;
        return resource!;
      });
    },
    /** Recovery can append identity after cutoff; it must never grant authority again. */
    recordResource(identity: RuntimeReviewerIdentity, leaseId: string, intentId: string, observed: Record<string, string>): Promise<void> {
      z.string().uuid().parse(intentId);
      z.record(z.string().min(1).max(80), z.string().min(1).max(512)).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 16).parse(observed);
      return transaction(identity, async tx => {
        const lease = await allocated(tx, identity, leaseId);
        if (!['allocating', 'ready', 'releasing'].includes(lease.state)) refuse('resource_recording_closed');
        const [resource] = await tx<RuntimeResourceIntent[]>`SELECT * FROM harness_shared.blind_review_runtime_resources
          WHERE id = ${intentId} AND lease_id = ${leaseId} AND workspace_id = ${identity.workspaceId} FOR UPDATE`;
        if (!resource) refuse('resource_intent_missing');
        if (lease.state === 'ready' && resource.kind !== 'capture') refuse('resource_recording_closed');
        if (resource.identity) {
          if (canonical(resource.identity) !== canonical(observed)) refuse('resource_identity_changed');
          return;
        }
        await tx`UPDATE harness_shared.blind_review_runtime_resources
          SET identity = ${JSON.stringify(observed)}::jsonb, recorded_at = clock_timestamp() WHERE id = ${intentId}`;
      }, true);
    },
    markReady(identity: RuntimeReviewerIdentity, leaseId: string): Promise<RuntimeLease> {
      return transaction(identity, async tx => {
        const lease = await allocated(tx, identity, leaseId);
        if (lease.state !== 'allocating' && lease.state !== 'ready') refuse('allocation_not_active');
        await assertLive(tx, leaseId);
        const resources = await tx<RuntimeResourceIntent[]>`SELECT * FROM harness_shared.blind_review_runtime_resources
          WHERE lease_id = ${leaseId} AND workspace_id = ${identity.workspaceId}`;
        const kinds = new Set(resources.map(r => r.kind));
        if (resources.some(r => r.identity === null) || RUNTIME_RESOURCE_KINDS.some(k => k !== 'capture' && !kinds.has(k))) {
          refuse('runtime_inventory_incomplete');
        }
        const [row] = await tx<RuntimeLease[]>`UPDATE harness_shared.blind_review_runtime_leases
          SET state = 'ready', updated_at = clock_timestamp() WHERE id = ${leaseId} RETURNING *`;
        return row!;
      });
    },
    /** Dispatch and successful response each need a fresh, short transaction. */
    authorize(identity: RuntimeReviewerIdentity, leaseId: string, runtime: {
      leaseEpoch: string; runtimeNonce: string;
    }): Promise<RuntimeLease> {
      z.object({ leaseEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/),
        runtimeNonce: z.string().uuid() }).strict().parse(runtime);
      return transaction(identity, async tx => {
        const lease = await allocated(tx, identity, leaseId);
        if (String(lease.lease_epoch) !== runtime.leaseEpoch || lease.runtime_nonce !== runtime.runtimeNonce)
          refuse('runtime_identity_mismatch');
        if (lease.state !== 'ready') refuse('runtime_not_ready');
        await assertLive(tx, leaseId);
        return lease;
      });
    },
    revoke(identity: RuntimeReviewerIdentity, leaseId: string, reason: string): Promise<RuntimeLease> {
      z.string().min(1).max(200).parse(reason);
      return transaction(identity, async tx => {
        const lease = await allocated(tx, identity, leaseId);
        if (lease.state === 'released') return lease;
        const [row] = await tx<RuntimeLease[]>`UPDATE harness_shared.blind_review_runtime_leases
          SET state = 'releasing', revoked_at = COALESCE(revoked_at, clock_timestamp()),
            release_reason = COALESCE(release_reason, ${reason}), updated_at = clock_timestamp()
          WHERE id = ${leaseId} RETURNING *`;
        return row!;
      }, true);
    },
    /**
     * The reaper supplies an independent whole-scope discovery oracle, including
     * intents whose create succeeded but identity append crashed. No oracle, an
     * unknown result, a timeout or an incomplete census can produce released.
     */
    confirmReleased(identity: RuntimeReviewerIdentity, leaseId: string, inspect: (
      resources: readonly RuntimeResourceIntent[], signal: AbortSignal,
    ) => Promise<{ scopeAbsent: boolean; absentIntentIds: string[]; checkedKinds: RuntimeResourceKind[] }>): Promise<boolean> {
      return transaction(identity, async tx => {
        const lease = await allocated(tx, identity, leaseId);
        if (lease.state === 'released') return true;
        if (lease.state !== 'releasing' || !lease.revoked_at) refuse('lease_not_revoked');
        const resources = await tx<RuntimeResourceIntent[]>`SELECT * FROM harness_shared.blind_review_runtime_resources
          WHERE lease_id = ${leaseId} AND workspace_id = ${identity.workspaceId}`;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const proof = await Promise.race([
            inspect(resources, controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => { controller.abort(); reject(new Error('absence_census_timeout')); }, 5000);
              timer.unref?.();
            }),
          ]);
          const absent = new Set(proof.absentIntentIds), kinds = new Set(proof.checkedKinds);
          if (proof.scopeAbsent !== true || absent.size !== resources.length ||
              resources.some(r => !absent.has(r.id)) || kinds.size !== RUNTIME_RESOURCE_KINDS.length ||
              RUNTIME_RESOURCE_KINDS.some(k => !kinds.has(k))) return false;
          await tx`UPDATE harness_shared.blind_review_runtime_leases SET state = 'released', updated_at = clock_timestamp()
            WHERE id = ${leaseId}`;
          return true;
        } catch {
          return false;
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }
      }, true);
    },
  };
}
