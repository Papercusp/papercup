/**
 * The GUARD's own correctness (EI-19325897270823423).
 *
 * A guard that only ever runs against a clean tree proves nothing — it would pass
 * identically if its predicate were `return false`. So the property under test is
 * "a NEW unbounded readInbox/readOutbox call fails", driven against synthetic
 * sources, the same discipline every sibling `check-*-guard.test.ts` applies to
 * its own predicate.
 */
import { describe, it, expect } from 'vitest';
import { isUnboundedInboxCall, ALLOWLIST } from '../../../../../scripts/check-unbounded-inbox-read.mjs';

describe('isUnboundedInboxCall', () => {
  it('FAILS a readInbox call with no since_ts and no window', () => {
    const src = `await readInbox(ownerId, { kinds: ['notify'] });`;
    expect(isUnboundedInboxCall(src)).toBe(true);
  });

  it('FAILS a readOutbox call with an empty opts object', () => {
    const src = `const recent = await readOutbox(OWNER, {});`;
    expect(isUnboundedInboxCall(src)).toBe(true);
  });

  it('FAILS a readInbox call with no opts argument at all', () => {
    const src = `await readInbox(ownerId);`;
    expect(isUnboundedInboxCall(src)).toBe(true);
  });

  it('passes a call bounded by since_ts', () => {
    const src = `await readInbox(ownerId, { since_ts: sinceIso, excludeOwn: true });`;
    expect(isUnboundedInboxCall(src)).toBe(false);
  });

  it('passes a call bounded by a third (window/enough) argument', () => {
    const src = `await readInbox(owner, {}, { enough: (entries) => entries.length >= TAIL });`;
    expect(isUnboundedInboxCall(src)).toBe(false);
  });

  it('passes a readOutbox call bounded by since_ts across multiple lines', () => {
    const src = `
      const recent = await readOutbox(HALT_RESCUE_OWNER, {
        since_ts: new Date(nowMs - throttleMs).toISOString(),
      }).catch(() => []);
    `;
    expect(isUnboundedInboxCall(src)).toBe(false);
  });

  it('ignores the readInbox/readOutbox function DECLARATIONS themselves', () => {
    const src = `
export async function readInbox(
  ownerId: string,
  opts: InboxOptions = {},
  window?: CoordWindowSpec,
): Promise<CoordEnvelope[]> {
  return [];
}`;
    expect(isUnboundedInboxCall(src)).toBe(false);
  });

  it('ignores a file that merely TALKS about readInbox in a comment', () => {
    // Several files explain the fallback shape at length; a doc-comment referencing
    // readInbox(owner, {}) is not a call, and flagging one would train people to
    // ignore the guard.
    const src = `
// Falls back to \`readInbox(ownerId, { kinds: ['notify'] })\` restricted to hindsight
// notifies when the PG fast path is unavailable.
export function noop() {}`;
    expect(isUnboundedInboxCall(src)).toBe(false);
  });

  it('does not confuse readInboxWindow/readOutboxWindow calls for the unbounded form', () => {
    const src = `
      const paged = await readInboxWindow(ownerId, opts, enoughFn);
      const paged2 = await readOutboxWindow(ownerId, opts, enoughFn);
    `;
    expect(isUnboundedInboxCall(src)).toBe(false);
  });

  it('flags the SECOND call even when an earlier call in the same file is bounded', () => {
    const src = `
      const a = await readInbox(owner, { since_ts: since });
      const b = await readInbox(owner, {});
    `;
    expect(isUnboundedInboxCall(src)).toBe(true);
  });
});

describe('ALLOWLIST hygiene', () => {
  it('stays small — only the definition file and its documented fallback caller', () => {
    // The point of this guard is that a NEW per-turn hot path reaches for since_ts/
    // window rather than being exempted. If this grows, the guard has drifted back
    // into rubber-stamp territory and needs re-scoping.
    expect(ALLOWLIST.size).toBeLessThanOrEqual(4);
  });

  it('contains the messages.ts definition file', () => {
    expect(ALLOWLIST.has('packages/operator-core/lib/agent-tools/coordination/messages.ts')).toBe(true);
  });
});
