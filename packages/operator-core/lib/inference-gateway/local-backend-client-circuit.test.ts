import { describe, expect, it } from 'vitest';
import {
  CLIENT_CIRCUIT_ZERO,
  DEFAULT_CLIENT_CIRCUIT_COOLDOWN_MS,
  DEFAULT_CLIENT_FAILURE_THRESHOLD,
  DEFAULT_CLIENT_MAX_IN_FLIGHT,
  admitClient,
  nextClientCircuitState,
  shouldShedClient,
  type ClientCircuitState,
} from './local-backend-client-circuit';

describe('shouldShedClient — in-flight cap', () => {
  it('admits a fresh owner (zero state)', () => {
    expect(shouldShedClient(CLIENT_CIRCUIT_ZERO, 1000).shed).toBe(false);
  });

  it('sheds once inFlight reaches the cap', () => {
    const state: ClientCircuitState = { inFlight: 2, consecutiveFailures: 0, openUntil: null };
    const v = shouldShedClient(state, 1000, 2);
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('in_flight_cap');
  });

  it('admits again once inFlight drops back under the cap', () => {
    const state: ClientCircuitState = { inFlight: 1, consecutiveFailures: 0, openUntil: null };
    expect(shouldShedClient(state, 1000, 2).shed).toBe(false);
  });

  it('defaults maxInFlight to DEFAULT_CLIENT_MAX_IN_FLIGHT when omitted', () => {
    const state: ClientCircuitState = { inFlight: DEFAULT_CLIENT_MAX_IN_FLIGHT, consecutiveFailures: 0, openUntil: null };
    expect(shouldShedClient(state, 1000).shed).toBe(true);
  });
});

describe('shouldShedClient — open circuit', () => {
  it('sheds with a retryAfterSec while the circuit is open, regardless of inFlight', () => {
    const state: ClientCircuitState = { inFlight: 0, consecutiveFailures: 3, openUntil: 5000 };
    const v = shouldShedClient(state, 1000, 100);
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('circuit_open');
    expect(v.retryAfterSec).toBe(4); // ceil((5000-1000)/1000)
  });

  it('retryAfterSec floors at 1 even with <1s remaining', () => {
    const state: ClientCircuitState = { inFlight: 0, consecutiveFailures: 3, openUntil: 1200 };
    expect(shouldShedClient(state, 1000, 100).retryAfterSec).toBe(1);
  });

  it('admits again once `now` passes openUntil (the circuit self-closes)', () => {
    const state: ClientCircuitState = { inFlight: 0, consecutiveFailures: 3, openUntil: 5000 };
    expect(shouldShedClient(state, 5000, 100).shed).toBe(false);
  });
});

describe('admitClient', () => {
  it('increments inFlight without touching the rest of the state', () => {
    const state: ClientCircuitState = { inFlight: 1, consecutiveFailures: 2, openUntil: null };
    expect(admitClient(state)).toEqual({ inFlight: 2, consecutiveFailures: 2, openUntil: null });
  });
});

describe('nextClientCircuitState', () => {
  it('a success resets consecutiveFailures + closes the circuit, and decrements inFlight', () => {
    const prev: ClientCircuitState = { inFlight: 1, consecutiveFailures: 2, openUntil: null };
    expect(nextClientCircuitState(prev, true, 1000)).toEqual({ inFlight: 0, consecutiveFailures: 0, openUntil: null });
  });

  it('a success closes an ALREADY-open circuit immediately (fast recovery, not a durable ban)', () => {
    const prev: ClientCircuitState = { inFlight: 1, consecutiveFailures: 5, openUntil: 999_999 };
    expect(nextClientCircuitState(prev, true, 1000)).toEqual({ inFlight: 0, consecutiveFailures: 0, openUntil: null });
  });

  it('a single failure does not open the circuit (not a lone-blip trip)', () => {
    const prev = CLIENT_CIRCUIT_ZERO;
    const next = nextClientCircuitState(prev, false, 1000, 3, 15_000);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.openUntil).toBeNull();
  });

  it('opens the circuit the instant consecutiveFailures reaches the threshold', () => {
    let state: ClientCircuitState = CLIENT_CIRCUIT_ZERO;
    state = admitClient(state);
    state = nextClientCircuitState(state, false, 1000, 3, 15_000); // 1
    state = admitClient(state);
    state = nextClientCircuitState(state, false, 2000, 3, 15_000); // 2 — still closed
    expect(state.openUntil).toBeNull();
    state = admitClient(state);
    state = nextClientCircuitState(state, false, 3000, 3, 15_000); // 3 — trips
    expect(state.consecutiveFailures).toBe(3);
    expect(state.openUntil).toBe(3000 + 15_000);
  });

  it('inFlight never goes negative even if decremented past zero (defensive floor)', () => {
    const prev: ClientCircuitState = { inFlight: 0, consecutiveFailures: 0, openUntil: null };
    expect(nextClientCircuitState(prev, true, 1000).inFlight).toBe(0);
  });

  it('respects custom threshold/cooldown overrides', () => {
    let state: ClientCircuitState = CLIENT_CIRCUIT_ZERO;
    state = admitClient(state);
    state = nextClientCircuitState(state, false, 1000, 1, 5_000); // threshold 1 — trips on the FIRST failure
    expect(state.openUntil).toBe(1000 + 5_000);
  });

  it('default threshold/cooldown match the exported defaults', () => {
    let state: ClientCircuitState = CLIENT_CIRCUIT_ZERO;
    for (let i = 0; i < DEFAULT_CLIENT_FAILURE_THRESHOLD; i++) {
      state = admitClient(state);
      state = nextClientCircuitState(state, false, 1000);
    }
    expect(state.openUntil).toBe(1000 + DEFAULT_CLIENT_CIRCUIT_COOLDOWN_MS);
  });
});

describe('end-to-end admission sequence (simulates the gateway hot path)', () => {
  it('a storming client (many parallel requests) is shed by the in-flight cap, not the failure circuit', () => {
    let state: ClientCircuitState = CLIENT_CIRCUIT_ZERO;
    const maxInFlight = 2;
    // Two requests admitted...
    expect(shouldShedClient(state, 1000, maxInFlight).shed).toBe(false);
    state = admitClient(state);
    expect(shouldShedClient(state, 1000, maxInFlight).shed).toBe(false);
    state = admitClient(state);
    // ...a third is shed WITHOUT ever reaching the backend (no failure recorded — cheap reject).
    const v = shouldShedClient(state, 1000, maxInFlight);
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('in_flight_cap');
    expect(state.consecutiveFailures).toBe(0);
  });

  it('a wedged client whose requests keep exhausting the pool eventually gets fast-shed by the circuit', () => {
    let state: ClientCircuitState = CLIENT_CIRCUIT_ZERO;
    for (let i = 0; i < DEFAULT_CLIENT_FAILURE_THRESHOLD; i++) {
      expect(shouldShedClient(state, i * 1000).shed).toBe(false); // each request is admitted...
      state = admitClient(state);
      state = nextClientCircuitState(state, false, i * 1000); // ...and fails (no reachable backend)
    }
    // The NEXT request is shed immediately — no backend attempt, no repeat of the exhaustion.
    const v = shouldShedClient(state, DEFAULT_CLIENT_FAILURE_THRESHOLD * 1000);
    expect(v.shed).toBe(true);
    expect(v.reason).toBe('circuit_open');
  });
});
