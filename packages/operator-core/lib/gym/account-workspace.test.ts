import { describe, it, expect } from 'vitest';
import { resolveGymAccountWorkspace } from './account-workspace';

/**
 * WI-5637 regression: the gym must route account selection to the operator's
 * CREDENTIAL workspace (where `operator_account_pool` lives), never the ephemeral
 * gym DATA workspace (`gym-loop-ws`, which has no pool). Passing the data workspace
 * made `resolveSpawnGatewayEnv({account:'auto'})` throw "no allowed claude account
 * in the pool" → the curator fell back to the local `~/.claude` login → 429.
 */
describe('resolveGymAccountWorkspace (WI-5637)', () => {
  const OPERATOR_WS = 'papercusp-workspace';
  const active = () => OPERATOR_WS;

  it('prefers the explicit GYM_LOOP_ACCOUNT_WORKSPACE override', () => {
    const ws = resolveGymAccountWorkspace(
      { GYM_LOOP_ACCOUNT_WORKSPACE: 'ws-explicit', PAPERCUSP_WORKSPACE_ID: 'ws-pin' } as NodeJS.ProcessEnv,
      active,
    );
    expect(ws).toBe('ws-explicit');
  });

  it('falls back to the PAPERCUSP_WORKSPACE_ID process pin', () => {
    const ws = resolveGymAccountWorkspace(
      { PAPERCUSP_WORKSPACE_ID: 'ws-pin' } as NodeJS.ProcessEnv,
      active,
    );
    expect(ws).toBe('ws-pin');
  });

  it('falls back to the operator active workspace (where the account pool lives)', () => {
    const ws = resolveGymAccountWorkspace({} as NodeJS.ProcessEnv, active);
    expect(ws).toBe(OPERATOR_WS);
  });

  it('ignores blank/whitespace overrides (does not resolve to an empty workspace)', () => {
    const ws = resolveGymAccountWorkspace(
      { GYM_LOOP_ACCOUNT_WORKSPACE: '   ', PAPERCUSP_WORKSPACE_ID: 'ws-pin' } as NodeJS.ProcessEnv,
      active,
    );
    expect(ws).toBe('ws-pin');
  });

  it('REGRESSION: never returns the ephemeral gym data workspace — the WI-5637 curator-429 bug', () => {
    // Simulate the gym's real environment: the process is pinned to the credential
    // workspace and the active workspace is the credential workspace. The resolver
    // must NOT hand back the gym data workspace 'gym-loop-ws' (no account pool).
    const ws = resolveGymAccountWorkspace(
      { PAPERCUSP_WORKSPACE_ID: OPERATOR_WS } as NodeJS.ProcessEnv,
      () => OPERATOR_WS,
    );
    expect(ws).not.toBe('gym-loop-ws');
    expect(ws).toBe(OPERATOR_WS);
  });
});
