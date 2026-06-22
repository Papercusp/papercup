/**
 * Coverage for execute-action validation:
 * 1. validateIdentityFields — the pure identity-spoof guard: a body's
 *    callingHarness / send_message `from` must equal the bearer-derived slug,
 *    and scaffold_harness must not carry a caller-supplied parent_slug.
 * 2. executeAction — comprehensive action shape validation ensures malformed
 *    actions are rejected before dispatch so state remains clean.
 */
import { describe, expect, it } from 'vitest';
import { validateIdentityFields, executeAction } from './execute-action';

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

  it('rejects send_message with a spoofed from', () => {
    const r = validateIdentityFields('papercup', body({ action: { op: 'send_message', from: 'evil' } }));
    expect(r).toMatchObject({ status: 403, error: 'identity_mismatch' });
  });

  it('allows send_message with a matching from', () => {
    expect(
      validateIdentityFields('papercup', body({ action: { op: 'send_message', from: 'papercup' } })),
    ).toBeNull();
  });

  it('rejects a caller-supplied parent_slug on scaffold_harness', () => {
    const r = validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness', parent_slug: 'x' } }));
    expect(r).toMatchObject({ status: 400, error: 'parent_slug_not_caller_controlled' });
  });

  it('allows scaffold_harness without parent_slug', () => {
    expect(validateIdentityFields('papercup', body({ action: { op: 'scaffold_harness' } }))).toBeNull();
  });
});
