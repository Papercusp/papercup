import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createWorkItem, getWorkItem, nextWorkItemId, type CreateWorkItemInput, type WorkItem } from '../work-items';
import type { ExternalRuntimeProducerBinding } from './operation-worker-binding';

const text = z.string().min(1).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const admissionSchema = z.object({
  workspaceId: text, harnessSlug: text, storageHarnessSlug: text, executionOwnerId: text,
  ownerId: text, roomName: text, callKey: text, callId: text,
  runId: text, jobId: text, configFingerprint: text,
  sessionStartedAt: text.refine((value) => Number.isFinite(Date.parse(value))),
  workerAdmitted: z.boolean(), contentDeleted: z.boolean(), sessionEndedAt: text.nullable(),
});

/** All identity fields come from host records, not an MCP request body. */
export type PhoneProducerAdmission = z.infer<typeof admissionSchema>;
export interface PhoneProducerAdmissionHost {
  readAdmission(roomName: string): Promise<PhoneProducerAdmission>;
  readRegistration(roomName: string): Promise<ExternalRuntimeProducerBinding | null>;
  /** First-write-wins transaction on phone_call_units. Re-read owner, call,
   * runtime, live worker admission, deletion and session-end under that lock;
   * refuse a changed snapshot. An existing exact registration may replay after
   * end/expiry. Return the winner, never replace it with the proposed binding. */
  reserveRegistration(snapshot: PhoneProducerAdmission, proposed: ExternalRuntimeProducerBinding): Promise<ExternalRuntimeProducerBinding>;
}

type ProducerRow = Pick<WorkItem, 'id' | 'harness' | 'assignee' | 'payload'>;
export interface PhoneProducerCanonicalStore {
  allocateId(): Promise<string>;
  read(id: string, harness: string): Promise<ProducerRow | null>;
  create(input: CreateWorkItemInput): Promise<ProducerRow>;
}
const canonicalStore: PhoneProducerCanonicalStore = {
  allocateId: nextWorkItemId,
  read: (id, harness) => getWorkItem(id, harness),
  create: createWorkItem,
};

function expectedBinding(snapshot: PhoneProducerAdmission, id: string): ExternalRuntimeProducerBinding {
  return { kind: 'external-runtime-producer', workspaceId: snapshot.workspaceId,
    harnessSlug: snapshot.harnessSlug, storageHarnessSlug: snapshot.storageHarnessSlug,
    workItemId: id, executionOwnerId: snapshot.executionOwnerId, ownerId: snapshot.ownerId,
    callKey: snapshot.callKey, callId: snapshot.callId, runId: snapshot.runId, jobId: snapshot.jobId,
    configurationSha256: createHash('sha256').update(snapshot.configFingerprint, 'utf8').digest('hex'),
    registeredAt: snapshot.sessionStartedAt };
}

/** Internal authenticated host adapter; do not expose host/store callbacks as
 * public arguments. Reservation precedes canonical create so a crash between
 * the two writes recovers the same ID. No accepted-operation/program identity
 * is minted for an external voice process. Terminal settlement is separate. */
export async function admitPhoneProducer(host: PhoneProducerAdmissionHost, roomName: string,
  store: PhoneProducerCanonicalStore = canonicalStore): Promise<Readonly<ExternalRuntimeProducerBinding>> {
  const snapshot = Object.freeze(admissionSchema.parse(await host.readAdmission(roomName)));
  if (snapshot.roomName !== roomName || snapshot.contentDeleted) throw new Error('phone_producer_call_unavailable');
  let registered = await host.readRegistration(roomName);
  if (!registered) {
    if (!snapshot.workerAdmitted || snapshot.sessionEndedAt !== null) throw new Error('phone_producer_not_admitted');
    const proposed = Object.freeze(expectedBinding(snapshot, await store.allocateId()));
    registered = await host.reserveRegistration(snapshot, proposed);
  }
  // Concurrent reservation may have won with another ID; every other field
  // must still be the independently read admitted call/runtime identity.
  if (!registered.workItemId || !isDeepStrictEqual(registered, expectedBinding(snapshot, registered.workItemId))) {
    throw new Error('phone_producer_registration_conflict');
  }
  const binding = Object.freeze({ ...registered });
  let row = await store.read(binding.workItemId, binding.storageHarnessSlug);
  if (!row) {
    try {
      await store.create({ id: binding.workItemId, kind: 'task',
        title: `Phone voice session ${binding.callId}`, summary: `Admitted voice runtime ${binding.runId}/${binding.jobId}`,
        workspaceId: binding.workspaceId, harness: binding.harnessSlug,
        createdBy: binding.executionOwnerId, assignee: binding.executionOwnerId,
        payload: { externalRuntimeProducer: binding } });
    } catch (error) {
      // A duplicate or lost response is recoverable only from the canonical
      // row. Never retry with a fresh ID or swallow an absent-row failure.
      row = await store.read(binding.workItemId, binding.storageHarnessSlug);
      if (!row) throw error;
    }
    row ??= await store.read(binding.workItemId, binding.storageHarnessSlug);
  }
  const payload = row?.payload as { externalRuntimeProducer?: unknown } | undefined;
  if (!row || row.id !== binding.workItemId || row.harness !== binding.storageHarnessSlug ||
      row.assignee !== binding.executionOwnerId || !isDeepStrictEqual(payload?.externalRuntimeProducer, binding)) {
    throw new Error('phone_producer_canonical_binding_conflict');
  }
  const after = admissionSchema.parse(await host.readAdmission(roomName));
  const afterRegistration = await host.readRegistration(roomName);
  if (after.contentDeleted || after.roomName !== roomName ||
      !isDeepStrictEqual(expectedBinding(after, binding.workItemId), binding) ||
      !isDeepStrictEqual(afterRegistration, binding)) throw new Error('phone_producer_registration_changed');
  return binding;
}
