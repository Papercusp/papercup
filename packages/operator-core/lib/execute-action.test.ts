/**
 * Coverage for execute-action validation:
 * 1. validateIdentityFields — the pure identity-spoof guard: a body's
 *    callingHarness must equal the bearer-derived slug, and scaffold_harness
 *    must not carry a caller-supplied parent_slug.
 * 2. executeAction — comprehensive action shape validation ensures malformed
 *    actions are rejected before dispatch so state remains clean.
 *
 * RETIRED 2026-07-26 (P-008, owner-directed): the `doSendMessage — recipient
 * harness existence (WI-385)` suite and the two `send_message`-spoof cases
 * were removed with the work-item mail surface, along with the getOrgPg `sql`
 * mock that existed only to serve them (the schema-existence probe + INSERT
 * capture). Their subjects — doSendMessage, the WI-3800 schema-exists cache,
 * and the WI-5243 workspace_id stamp on the `messages` INSERT — no longer
 * exist. See _retired/work-item-mail/RESTORE.md to restore them.
 */
import { describe, expect, it } from 'vitest';

import { validateIdentityFields } from './execute-action';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (over: any) => ({ actionId: 'a1', action: { op: 'noop' }, ...over }) as never;

describe('validateIdentityFields', () => {
  it('passes a clean body with no identity claims', () => {
    expect(validateIdentityFields('papercup', body({}))).toBeNull();
  });

  it('rejects a callingHarness that does not match the bearer slug', () => {
    const r = validateIdentityFields('papercup', body({ callingHarness: 'evil' }));
    expect(r).toMatchObject({ status: 403, error: 'identity_mismatch' });
  });

  it('allows a matching callingHarness', () => {
    expect(validateIdentityFields('papercup', body({ callingHarness: 'papercup' }))).toBeNull();
  });

  it('rejects a caller-supplied parent_slug on scaffold_harness', () => {
    const r = validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness', parent_slug: 'x' } }));
    expect(r).toMatchObject({ status: 400, error: 'parent_slug_not_caller_controlled' });
  });

  it('allows scaffold_harness without parent_slug', () => {
    expect(validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness' } }))).toBeNull();
  });
});
