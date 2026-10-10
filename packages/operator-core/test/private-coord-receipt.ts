/** Correlate one action to its real persisted result, never a global fixture marker. */
import assert from 'node:assert/strict';

/** A stop receipt identifies one launch, not just an owner reused over time. */
export function verifyPrivateStopReceipt(
  receipt: { status: number; body: any },
  expected: { ownerId: string; managedSessionId: number; startedAt: string },
) {
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.ok, true);
  assert.equal(receipt.body.ownerId, expected.ownerId, 'selected-owner stop receipt correlation');
  assert.equal(receipt.body.managedSessionId, expected.managedSessionId, 'selected-session receipt correlation');
  assert.equal(receipt.body.sessionStartedAt, expected.startedAt, 'selected-launch stop receipt correlation');
  assert.equal(receipt.body.status, 'stop-requested', 'stop disposition must be explicit');
}

export async function verifyPrivateCoordReceipt(
  receipt: { status: number; body: any },
  expected: { ownerId: string; summary: string; wake: boolean },
  getStored: (id: string) => Promise<{ to: string[]; summary: string; wake?: boolean } | null>,
) {
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.results?.length, 1);
  const result = receipt.body.results[0];
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.to, [expected.ownerId], 'selected-recipient receipt correlation');
  assert.equal(typeof result.msg_id, 'string');
  const stored = await getStored(result.msg_id);
  assert.ok(stored, 'HTTP receipt must identify a durable message');
  assert.deepEqual(stored.to, [expected.ownerId], 'persisted recipient correlation');
  assert.equal(stored.summary, expected.summary, 'persisted action payload correlation');
  if (expected.wake) {
    assert.equal(result.wake?.pickupConfirmed, false, 'send-time wake cannot attest pickup');
    assert.equal(stored.wake, true);
  } else assert.notEqual(stored.wake, true, 'message action must not become a wake');
  return result.msg_id as string;
}
