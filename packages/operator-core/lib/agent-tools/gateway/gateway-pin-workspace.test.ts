/**
 * gateway-pin-workspace.test.ts — RECURRENCE GUARD for EI-20208335287200289.
 *
 * THE BUG: `accounts:pin` / `accounts:unpin` resolved their workspace with
 * `workspace ?? ctx?.workspaceId ?? ctx?.principal?.workspaceId ?? activeWorkspaceId()`. The admin
 * proxy (`/api/admin/accounts/:verb`) re-dispatches in-process with a synthesized `?superuser=1`
 * ctx and forwards no `workspace`, so `_mcp-handler`'s `workspaceId || '*'` supplied the `'*'`
 * READ sentinel — which is TRUTHY, so it won the `??` chain and the `activeWorkspaceId()` fallback
 * never fired. The pin landed under `workspace_id='*'`; `adv-roster.ts` reads
 * `getOwnerPinsMap(activeWorkspaceId())`. So the write returned `ok:true, appliedLive:true` and was
 * INVISIBLE to the ACCT pill that set it, and unpin — scoped to that same empty bucket — could not
 * clear the pins that really existed. Reporting success for a write nobody can read is the
 * false-reassurance shape this plan exists to eliminate.
 *
 * WHY A TEST AND NOT JUST THE FIX: the pre-existing unit tests mock `fetch`, so they assert the
 * pill's handling of the REPLY and can never see WHICH ROW the write landed in. Nothing typed
 * catches it either — `'*'` is a perfectly good `string`. Only asserting the bucket does.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/gateway/gateway-pin-workspace.test.ts
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';

// Capture the workspace each durable write is actually scoped to. This is the ONLY thing that
// distinguishes the bug from the fix — both return ok:true.
const writes: Array<{ op: 'set' | 'clear'; ws: string; ownerId: string }> = [];

vi.mock('../../deployment/account-owner-pins', () => ({
  setOwnerPin: async (workspaceId: string, ownerId: string, pin: { account: string; hard: boolean }) => {
    writes.push({ op: 'set', ws: workspaceId, ownerId });
    return pin;
  },
  clearOwnerPin: async (workspaceId: string, ownerId: string) => {
    writes.push({ op: 'clear', ws: workspaceId, ownerId });
    return true;
  },
}));

// NOT mocked: workspace-registry. The real `resolveConcreteWorkspaceId` (and the real
// `activeWorkspaceId` it falls back to) is the subject — mocking it would make this tautological.
const { accountsPinTool, accountsUnpinTool } = await import('./gateway');
const { activeWorkspaceId, resolveConcreteWorkspaceId } = await import('../../workspace-registry');

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);
const prevPort = process.env.PAPERCUSP_GATEWAY_PORT;

beforeEach(() => {
  writes.length = 0;
  // Nothing listening: /admin/config and the live push both fail. Both handlers are written to
  // fail SOFT there (the durable write is the source of truth), which is exactly the path the
  // bug shipped on — so this keeps the test on the real code path rather than a happy-path stub.
  process.env.PAPERCUSP_GATEWAY_PORT = '1';
});
afterEach(() => {
  if (prevPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = prevPort;
});

test("accounts:pin under a wildcard superuser ctx writes to the CONCRETE workspace, never '*'", async () => {
  const r = body(
    await accountsPinTool.handler(
      { agent: 'su-test-owner', account: 'acct-1' } as never,
      { workspaceId: '*' } as never,
    ),
  );
  assert.equal(r.ok, true);

  // CALIBRATION: if the handler never reached the durable write, every assertion below would pass
  // vacuously. Prove the capture harness actually captured something first.
  assert.equal(writes.length, 1, 'the handler reached the durable write (guard is not vacuous)');

  assert.notEqual(writes[0]!.ws, '*', "the pin must not land in the unreadable '*' bucket");
  assert.equal(
    writes[0]!.ws,
    activeWorkspaceId(),
    'the pin lands in the SAME workspace adv-roster reads pins from — the read-back the ACCT pill depends on',
  );
});

test("accounts:unpin under a wildcard superuser ctx clears from the CONCRETE workspace, never '*'", async () => {
  const r = body(
    await accountsUnpinTool.handler({ agent: 'su-test-owner' } as never, { workspaceId: '*' } as never),
  );
  assert.equal(r.ok, true);
  assert.equal(writes.length, 1, 'the handler reached the durable clear (guard is not vacuous)');
  assert.notEqual(writes[0]!.ws, '*', 'unpin scoped to the wildcard bucket cannot clear a real pin');
  assert.equal(writes[0]!.ws, activeWorkspaceId());
});

test("a wildcard on the PRINCIPAL leg is caught too — every leg is filtered, not just the first", async () => {
  await accountsPinTool.handler(
    { agent: 'su-test-owner', account: 'acct-1' } as never,
    { principal: { workspaceId: '*' } } as never,
  );
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0]!.ws, '*');
});

test('CONTROL: an explicit concrete workspace still wins over the ctx legs', async () => {
  await accountsPinTool.handler(
    { agent: 'su-test-owner', account: 'acct-1', workspace: 'other-workspace' } as never,
    { workspaceId: 'ctx-workspace' } as never,
  );
  assert.equal(writes[0]!.ws, 'other-workspace', 'an explicit arg is not swallowed by the wildcard filter');
});

test('FALSIFIABILITY: the pre-fix expression really does produce the unreadable bucket', () => {
  // A deliberately-wrong implementation kept permanently as a control, rather than mutating the
  // shared tree to prove the guard bites (a mutation probe here would race git-sync's sweep).
  // This is verbatim the expression both handlers used before the fix.
  const buggy = (workspace?: string, ctx?: { workspaceId?: string; principal?: { workspaceId?: string } }) =>
    workspace ?? ctx?.workspaceId ?? ctx?.principal?.workspaceId ?? activeWorkspaceId();

  // The old form under the admin proxy's ctx: '*' is truthy, so it wins and the fallback never runs.
  assert.equal(buggy(undefined, { workspaceId: '*' }), '*');
  // ...which is precisely what the tests above assert must NOT happen. So had they been written
  // against the old code they would have failed — the guard is falsifiable, not decorative.
  assert.notEqual(buggy(undefined, { workspaceId: '*' }), activeWorkspaceId());
  // Sanity on the environment itself: if activeWorkspaceId() were somehow '*', every assertion in
  // this file would pass for the wrong reason.
  assert.notEqual(activeWorkspaceId(), '*', 'the concrete-workspace baseline is itself concrete');
});

test("CONTROL: the resolver itself treats '*' and blank as not-concrete, and a real id as concrete", () => {
  // Pins the PROPERTY the handlers now depend on. If someone "simplifies" resolveConcreteWorkspaceId
  // back to a `??` chain, this fails here — naming the resolver — rather than only in the handlers.
  assert.equal(resolveConcreteWorkspaceId('*'), activeWorkspaceId());
  assert.equal(resolveConcreteWorkspaceId('   '), activeWorkspaceId());
  assert.equal(resolveConcreteWorkspaceId('*', 'real-ws'), 'real-ws', "a wildcard must not shadow a later concrete leg");
  assert.equal(resolveConcreteWorkspaceId(undefined, null, 'real-ws'), 'real-ws');
});
