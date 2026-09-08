import assert from 'node:assert/strict';
import test from 'node:test';
import { isLiveFleetSession, resolveHudSession, resolveHudSessionFromRoster } from './hud-session-fixture.mjs';

const live = (overrides = {}) => ({
  // Current Codex/OMP rows intentionally have no legacy Claude session id.
  sessionId: null,
  ownerId: 'su-owner',
  fleetSlug: 'fleet-live',
  liveness: 'live',
  stale: false,
  sessionState: 'parked',
  ...overrides,
});

test('accepts only active rows with a live fleet-bearing session', () => {
  assert.equal(isLiveFleetSession(live()), true);
  assert.equal(isLiveFleetSession(live({ ownerId: null, sessionId: 'legacy-claude-id' })), false);
  assert.equal(isLiveFleetSession(live({ fleetSlug: null })), false);
  assert.equal(isLiveFleetSession(live({ liveness: 'stale' })), false);
  assert.equal(isLiveFleetSession(live({ sessionState: 'ended' })), false);
});

test('keeps an explicit session override for historical reproduction', () => {
  assert.deepEqual(resolveHudSession({ envSession: '  su-recorded  ', roster: { active: [] } }), {
    sessionOwnerId: 'su-recorded',
    source: 'env',
  });
});

test('chooses a deterministic live fleet-bearing row by default', () => {
  const result = resolveHudSession({
    roster: {
      active: [
        live({ ownerId: 'owner-z' }),
        live({ ownerId: 'owner-a', fleetSlug: 'fleet-a' }),
        live({ ownerId: 'owner-recorded', liveness: 'recorded', stale: true }),
      ],
    },
  });
  assert.deepEqual(result, {
    sessionOwnerId: 'owner-a',
    source: 'live-roster',
    fleetSlug: 'fleet-a',
    ownerId: 'owner-a',
  });
});

test('accepts current Codex/OMP rows without the legacy sessionId', () => {
  const result = resolveHudSession({
    roster: {
      active: [
        live({ ownerId: 'omp-owner', source: 'omp' }),
        live({ ownerId: 'codex-owner', source: 'codex-cli' }),
      ],
    },
  });
  assert.deepEqual(result, {
    sessionOwnerId: 'codex-owner',
    source: 'live-roster',
    fleetSlug: 'fleet-live',
    ownerId: 'codex-owner',
  });
});

test('fails loudly when the active roster has no eligible session', () => {
  assert.throws(
    () => resolveHudSession({ roster: { active: [live({ fleetSlug: null })] } }),
    /No live fleet-bearing session/,
  );
});

test('fetches the live roster only when no override is supplied', async () => {
  const calls = [];
  const result = await resolveHudSessionFromRoster({
    base: 'http://127.0.0.1:3081/',
    fetchImpl: async url => {
      calls.push(url);
      return new Response(JSON.stringify({ active: [live()] }), { status: 200 });
    },
  });
  assert.deepEqual(result, {
    sessionOwnerId: 'su-owner',
    source: 'live-roster',
    fleetSlug: 'fleet-live',
    ownerId: 'su-owner',
    rosterUrl: 'http://127.0.0.1:3081/api/adv/roster',
  });
  assert.deepEqual(calls, ['http://127.0.0.1:3081/api/adv/roster']);
});
