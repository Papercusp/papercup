/**
 * INJECTION PORT REGISTRY — the two context-injection boundaries, and the
 * transport contract each one carries.
 *
 * Plan: codex-context-injection-parity-2026-08-09, D-001 (FROZEN, shared
 * verbatim with omp-context-injection-parity-2026-08-09).
 *
 * A "port" is a MOMENT in a turn at which the operator is allowed to push
 * context into the model, not a client event. Client events map ONTO ports
 * (that mapping is each adapter's `portForEvent`); the properties here are the
 * same for every client, which is exactly why they live in one file instead of
 * being re-derived per adapter.
 *
 * ⚠ EVERY NUMBER HERE IS CONTRACT, NOT TUNING (D-001 invariants 2 + 5).
 * The clamps bound the SERVER's query construction, so changing one changes
 * retrieval behaviour for every client at once. The timeouts bound what a slow
 * or down operator is allowed to cost a turn. Both were migrated verbatim from
 * the two claude shell hooks these ports generalise. Do not "round them off".
 */

/**
 * @typedef {'turn-start' | 'mid-turn'} InjectionPort
 */

/**
 * ⚠ THE TWO KILL-SWITCHES ARE NOT THE SAME KIND OF SWITCH — do not unify them.
 *
 * This asymmetry is the single most likely thing to be "cleaned up" by someone
 * reading only D-001's one-line summary ("PER-PORT KILL-SWITCH env:
 * PAPERCUSP_TURN_START_MEMORY=off, PAPERCUSP_MID_TURN_CONTEXT=off"), which
 * reads as though both simply disable their port. They do not, and flattening
 * them would silently delete a safety property:
 *
 *   PAPERCUSP_MID_TURN_CONTEXT=off  -> 'suppress'. The whole port goes away.
 *       Mid-turn carries recall only. Nothing is lost by not calling.
 *
 *   PAPERCUSP_TURN_START_MEMORY=off -> 'degrade'. The call STILL HAPPENS, with
 *       memoryEnabled=false. Turn-start carries TWO payloads on one request:
 *       the memory delta AND the one-shot CTRL transition (mode / loop / route
 *       changes). The env var is a MEMORY preference. A memory preference must
 *       never be able to hide a safety-critical control transition, so turning
 *       memory off must not stop the request.
 *
 * Verbatim source: apps/operator/scripts/hooks/cc/userpromptsubmit-memory.sh
 * ("PAPERCUSP_TURN_START_MEMORY=off disables only memory recall. CTRL
 * transitions remain enabled: a memory preference must never hide a
 * safety-critical mode / loop / route transition.") vs
 * posttoolbatch-midturn-context.sh (bare `exit 0` on off).
 *
 * @typedef {'suppress' | 'degrade'} KillSwitchMode
 */

/**
 * @typedef {object} PortSpec
 * @property {string} endpoint            Operator path. CLIENT-AGNOSTIC by design (D-001 invariant 6) — never fork this per client.
 * @property {number} timeoutMs           Hard wall. After this the turn proceeds un-augmented.
 * @property {string} killSwitchEnv       Env var that disables/degrades this port.
 * @property {KillSwitchMode} killSwitchMode  See the warning above.
 * @property {number} [promptClamp]       turn-start: max chars of prompt shipped.
 * @property {number} [maxCalls]          mid-turn: max tool calls shipped.
 * @property {number} [fieldClamp]        mid-turn: max chars per call field.
 */

/** @type {Record<InjectionPort, PortSpec>} */
export const PORTS = {
  'turn-start': {
    endpoint: '/api/agent-mcp/turn-start-memory',
    timeoutMs: 2500,
    killSwitchEnv: 'PAPERCUSP_TURN_START_MEMORY',
    killSwitchMode: 'degrade',
    promptClamp: 4000,
  },
  'mid-turn': {
    endpoint: '/api/agent-mcp/mid-turn-context',
    timeoutMs: 1500,
    killSwitchEnv: 'PAPERCUSP_MID_TURN_CONTEXT',
    killSwitchMode: 'suppress',
    maxCalls: 12,
    fieldClamp: 400,
  },
};

/** @type {InjectionPort[]} */
export const PORT_NAMES = /** @type {InjectionPort[]} */ (Object.keys(PORTS));

/** @param {unknown} value @returns {value is InjectionPort} */
export function isPort(value) {
  return typeof value === 'string' && Object.hasOwn(PORTS, value);
}

/**
 * Resolve a port's spec. Returns null for an unknown port rather than throwing:
 * every caller here is on a fail-silent path (D-001 invariant 1), and a thrown
 * error at this layer would have to be caught one frame later anyway.
 * @param {unknown} port
 * @returns {PortSpec | null}
 */
export function specFor(port) {
  return isPort(port) ? PORTS[port] : null;
}

/**
 * Is this port switched off, and how?
 *
 * Returns the MODE rather than a boolean so callers cannot collapse 'degrade'
 * into 'suppress' by accident — a boolean here is what would silently drop CTRL
 * transitions when a user turns memory off.
 *
 * @param {InjectionPort} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ off: boolean, mode: KillSwitchMode | null }}
 */
export function killSwitchState(port, env = process.env) {
  const spec = specFor(port);
  if (!spec) return { off: false, mode: null };
  const off = env[spec.killSwitchEnv] === 'off';
  return { off, mode: off ? spec.killSwitchMode : null };
}
