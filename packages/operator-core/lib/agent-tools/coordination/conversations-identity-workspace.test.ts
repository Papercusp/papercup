/**
 * conversations-identity-workspace.test.ts — WI-1571 (workspace-threading class,
 * sibling of WI-1564: scheduler:set_claim_spec's resolveClaimSpecWorkspace).
 *
 * THE BUG: a HARNESS-scoped conversation opened from a context with no request
 * ALS (a background/system caller) fell through to the literal 'default'
 * workspace partition (conversationsScopeWorkspace's request→env→'default'
 * chain), even when the caller's identity was scoped to a DIFFERENT, concrete
 * workspace (e.g. a queen principal's `principal.workspaceId`, the hive's real
 * home). The federation outbox-drain only serves the booted (workspace,
 * harness) handle for the hive's REAL home, so a row captured under
 * (default, <hive>) never federates (live evidence: 4 coord_conversations + 4
 * coord_threads rows undrained under (default, papercusp)).
 *
 * THE FIX: every identity-bearing conversations.ts entry point now runs
 * through `withConversationsIdentityScope`, which pins `identity.workspaceId`
 * (when concrete) onto the request-ALS for the call's async extent via
 * `runWithWorkspaceIfConcrete` — so `conversationsScopeWorkspace()` (the SAME
 * resolver every store read/write uses) picks it up as its top-priority read.
 *
 * These tests exercise the resolver + ALS-pinning plumbing directly (no DB
 * needed — `conversationsScopeWorkspace` only touches request-ALS + env, and
 * `withConversationsIdentityScope`'s side effect IS that ALS pin), proving:
 *  - a concrete identity.workspaceId is read back by conversationsScopeWorkspace
 *    with NO ambient request scope (the exact strand condition, now fixed);
 *  - an unscoped identity (workspaceId null/'*'/empty) is a NO-OP — the
 *    existing request→env→'default' chain is unchanged (non-regression);
 *  - a concrete request-ALS scope set OUTSIDE the identity wrapper still wins
 *    when the identity itself carries no workspace (nesting doesn't clobber
 *    an outer legitimate request scope with nothing);
 *  - TWO independent callers scoped to the SAME hive resolve to the SAME
 *    partition (the WI-1564 "resolver shared by writer+reader" invariant) —
 *    proven here as two `withConversationsIdentityScope` calls with the same
 *    identity.workspaceId both reading back that same value.
 */
import { describe, expect, it } from 'vitest';
import {
  conversationsScopeWorkspace,
  resolveConversationsIdentityWorkspace,
  withConversationsIdentityScope,
} from './conversations';
import { runWithWorkspace } from '../../workspace-als';
import type { AgentIdentity } from './identity';

function ident(workspaceId: string | null): AgentIdentity {
  return { ownerId: 'a', ownerLabel: 'a', source: 'static-client', workspaceId, userId: null };
}

describe('resolveConversationsIdentityWorkspace (WI-1571)', () => {
  it('a concrete workspaceId passes through trimmed', () => {
    expect(resolveConversationsIdentityWorkspace('  hive-ws  ')).toBe('hive-ws');
  });
  it('null / empty / "*" all resolve to undefined (no pin — existing chain applies)', () => {
    expect(resolveConversationsIdentityWorkspace(null)).toBeUndefined();
    expect(resolveConversationsIdentityWorkspace(undefined)).toBeUndefined();
    expect(resolveConversationsIdentityWorkspace('')).toBeUndefined();
    expect(resolveConversationsIdentityWorkspace('*')).toBeUndefined();
  });
});

describe('withConversationsIdentityScope pins identity.workspaceId onto conversationsScopeWorkspace (WI-1571)', () => {
  it('a harness-scoped background caller (no request ALS) resolves to the IDENTITY workspace, not default', () => {
    // The exact strand condition: no ambient request scope, a concrete
    // identity.workspaceId (e.g. a queen principal's hive-home workspace).
    const seen = withConversationsIdentityScope(ident('papercusp-workspace'), 'papercusp', () =>
      conversationsScopeWorkspace(),
    );
    expect(seen).toBe('papercusp-workspace');
  });

  it('an UNSCOPED identity (workspaceId null) is a no-op — falls through to the existing default chain', () => {
    const seen = withConversationsIdentityScope(ident(null), undefined, () => conversationsScopeWorkspace());
    // No request ALS, no PAPERCUSP_WORKSPACE_ID in this test env → the
    // pre-existing DEFAULT_COORD_WORKSPACE fallback, UNCHANGED by this fix.
    expect(seen).toBe('default');
  });

  it('two independent callers scoped to the SAME hive agree on the partition (writer+reader invariant)', () => {
    const writerSeen = withConversationsIdentityScope(ident('papercusp-workspace'), 'papercusp', () =>
      conversationsScopeWorkspace(),
    );
    const readerSeen = withConversationsIdentityScope(ident('papercusp-workspace'), undefined, () =>
      conversationsScopeWorkspace(),
    );
    expect(writerSeen).toBe(readerSeen);
    expect(writerSeen).toBe('papercusp-workspace');
  });

  it('nesting inside an outer request-ALS scope: an unscoped identity does not clobber the outer scope', () => {
    const seen = runWithWorkspace('outer-request-ws', () =>
      withConversationsIdentityScope(ident(null), undefined, () => conversationsScopeWorkspace()),
    );
    expect(seen).toBe('outer-request-ws');
  });

  it("nesting inside an outer request-ALS scope: a concrete identity workspace WINS (identity takes priority)", () => {
    const seen = runWithWorkspace('outer-request-ws', () =>
      withConversationsIdentityScope(ident('identity-ws'), undefined, () => conversationsScopeWorkspace()),
    );
    expect(seen).toBe('identity-ws');
  });
});
