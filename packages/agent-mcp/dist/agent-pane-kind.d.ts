/**
 * agent-pane-kind.ts — the shared AgentPaneKind taxonomy
 * (hive-agent-tabs-psu-tui-2026-06-09, P-001 / D-001..D-008).
 *
 * ONE source of truth for "what kind of agent tab is this" across the backend
 * (spawn / roster shaping) and pui (pane render + per-type color). The backend
 * stamps the resolved kind onto the roster entry; pui mirrors only the string
 * VALUES (a serde contract test in apps/tui guards the mirror) rather than
 * re-deriving the mapping — so there is no per-call string matching split across
 * two languages.
 *
 * The four owner-facing pane kinds (the zellij dock tabs the owner sees):
 *   - queen     — the autonomous brain: the `psu --brain` session, driven by the
 *                 cadence loop + events (D-006). Auto-injected by default.
 *   - bee       — a system-driven worker/role agent: the generic `bee`, the
 *                 pipeline roles (scoper…curator), AND the read-mostly fleet
 *                 `sentinel` WATCHER role + the other cross-cutting roles. Auto.
 *   - sentinel  — the always-on, owner-facing operator persona: the `operator`
 *                 role (operator-converse). Responsive. NB the COLLISION (D-001):
 *                 the *display* "Sentinel" == the operator persona (matching the
 *                 lexicon `operator → Sentinel`), which is DISTINCT from the
 *                 `sentinel` *role* (a fleet watcher → `bee` kind above). The
 *                 owner-facing tab named "Sentinel" is the operator persona.
 *   - planner   — an agent launched from Create → New plan (P-006). Responsive.
 *
 * `driveMode` is the ORTHOGONAL axis (D-003 / D-005): `auto` = the system
 * auto-injects the next turn (cadence loop / event wake); `responsive` = the
 * agent waits for the owner. It is the DEFAULT for the kind — the per-agent wake
 * mode (D-005) can still flip an `auto` agent to manual at runtime.
 */
export declare const AGENT_PANE_KINDS: readonly ["queen", "bee", "sentinel", "planner"];
export type AgentPaneKind = (typeof AGENT_PANE_KINDS)[number];
export declare const DRIVE_MODES: readonly ["auto", "responsive"];
export type DriveMode = (typeof DRIVE_MODES)[number];
export interface AgentPaneClass {
    kind: AgentPaneKind;
    driveMode: DriveMode;
}
/**
 * How the session was launched, when the role alone doesn't disambiguate.
 * `brain` = the pinned `psu --brain` Queen; `planner` = a Create → New plan
 * launch. Absent for an ordinary role spawn.
 */
export type AgentLaunchHint = 'brain' | 'planner' | undefined;
/**
 * Classify an agent into its dock pane-kind + drive mode from its role and an
 * optional launch hint. Precedence (most specific first):
 *   1. brain launch OR the `brain` principal role → queen / auto  (BRAIN_PRINCIPAL_ROLE)
 *   2. planner launch/role   → planner / responsive
 *   3. operator role         → sentinel / responsive   (the owner-facing persona)
 *   4. oracle role           → sentinel / responsive   (a responsive Q&A chat)
 *   5. everything else       → bee / auto   (pipeline roles, the generic `bee`,
 *                              the `sentinel` WATCHER role, reviewers, orchestrator…)
 */
export declare function classifyAgentPane(input: {
    role?: string | null;
    launch?: AgentLaunchHint;
}): AgentPaneClass;
