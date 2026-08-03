/**
 * task-manager/scope-class — is an out-of-slice process an ESCAPE, or a lifetime
 * we deliberately do not own? (EI-19325095302441792)
 *
 * `scan` answers one question per process: is it inside `papercusp.slice`? That
 * boolean is exactly right for the RECONCILER, which only needs to know whose rows
 * it may close. It is not enough for a HUMAN, and shipping it raw to the pane made
 * the pane lie: every `owned:false` row rendered as "UNENROLLED — the visible gap",
 * so 643 of 655 processes on this box were presented as escapees. The author of the
 * pane (me) read its own output and reported a 98% coverage hole to the owner, then
 * had to retract it. The dominant population is the owner's own terminal windows,
 * which are the FIRST named entry in the spawn guard's allowlist.
 *
 * ── WHY THE GUARD'S ALLOWLIST CANNOT BE THE RUNTIME AUTHORITY ────────────────
 *
 * The work-item that commissioned this file asked for the classification to be
 * "driven by the guard's allowlist, not by a cgroup-name heuristic". Building it
 * proved that impossible, and the correction is worth stating rather than quietly
 * working around: `ALLOWLIST` in `scripts/check-no-unenrolled-detached-spawn.mjs`
 * keys on SOURCE FILE PATHS. It answers "may this call site spawn detached without
 * enrolling?" — a build-time question about code. A running process carries no
 * source path, so nothing at runtime can look itself up in that map.
 *
 * The two are different authorities for the same intent, and this file is the
 * RUNTIME one. Every rule below cites the allowlist entry it corresponds to, so a
 * reader can check the correspondence by hand; a test asserts the pairing. What is
 * NOT claimed is that the two can be mechanically derived from each other.
 *
 * ── WHY THESE RULES ARE STRUCTURAL, NOT A NAME LIST ──────────────────────────
 *
 * A list of process names would be the same mistake as `pkill -f '<binary>'`: it
 * goes stale silently and matches things it never meant to. Both rules here are
 * properties of how systemd ACCOUNTS for the process, which is the actual question:
 *
 *   human-terminal — the cgroup sits under GNOME Terminal's app slice (each window
 *     gets its own `vte-spawn-<uuid>.scope`). The window is the unit of control and
 *     the human owns it. Guard allowlist: `console-spawn.ts` / `terminal-spawn.ts`,
 *     "a human's terminal WINDOW is the unit of control".
 *
 *     ONLY WHILE THE WINDOW IS OPEN. The scope outlives the window — it persists as
 *     long as anything inside it is alive — so a closed window leaves a scope full of
 *     processes still claiming an exemption that says a human is watching them. On
 *     this box that was 17 scopes holding 123 processes. `terminalWindowAlive:false`
 *     withdraws the exemption; see `terminal-window` for how it is observed and why
 *     "we could not tell" must never withdraw it.
 *
 *   systemd-unit — the leaf is a `.service`, so systemd owns its lifecycle: it has
 *     a journal, a stop verb, and (for non-transient units) a restart policy. It is
 *     accounted for by a different accountant, not unaccounted for. Guard allowlist:
 *     `dev/restart.ts` ("already supervised by SUPERVISED_PROCESSES + unit-reconciler")
 *     and `release-actions.ts` ("must survive the operator restart it performs").
 *
 * Everything else outside our slice is genuinely `unaccounted` — and that residue is
 * small and actionable rather than alarming-and-ignored. On this box it is dominated
 * by `papercup-headless-*.scope` members: `buildHeadlessSpawnCommand` falls back to
 * that name when the caller passes no `taskScope`, i.e. exactly the P-009 gap. That
 * is the number the pane should have been showing in red all along.
 */

/**
 * `abandoned-window` is its OWN class, not a flavour of the other three (P-008 / D-018).
 *
 * It was `exempt` (wrong — the human whose lifetime justified the exemption is
 * gone) and then briefly `unaccounted`, which is true but throws away the one
 * fact that makes it actionable and non-alarming: a human DID own this, and then
 * closed the window. That distinction is what lets the pane say "a window closed
 * but these kept running" instead of either "nothing to see" or "an escape".
 */
export type ProcessScope = 'owned' | 'exempt' | 'abandoned-window' | 'unaccounted';

/** Why an out-of-slice process is not an escapee. Extend only with a structural rule. */
export type ExemptReason = 'human-terminal' | 'systemd-unit';

export interface ScopeClassification {
  scope: ProcessScope;
  /** Non-null exactly when `scope === 'exempt'`. */
  exemptReason: ExemptReason | null;
}

/** GNOME Terminal's app slice — every terminal WINDOW is a `vte-spawn-*.scope` under it. */
/**
 * The terminal application's own slice — the PARENT of the `vte-spawn-*.scope`
 * dirs. Exported because the residue census (`terminal-residue-census`) has to
 * resolve the same slice, and a second hand-written copy of this string is
 * exactly how the two would drift apart (the same reasoning as
 * `isTerminalWindowScope` owning the scope regex rather than the caller).
 *
 * ⚠ Not `app.slice`. Probing the wider slice collects every desktop application's
 * pids as "terminal app pids", and since a window counts as ALIVE when any of its
 * processes has a parent in that set, everything reads alive and a census reports
 * zero dead scopes — a false CLEAN, the direction that hides residue.
 */
export const TERMINAL_SLICE = 'app-org.gnome.Terminal.slice';
const VTE_SCOPE_RE = /^vte-spawn-[0-9a-fA-F-]+\.scope$/;

function segments(cgroupPath: string): string[] {
  return cgroupPath.split('/').filter(Boolean);
}

/**
 * Is this cgroup one terminal WINDOW's own scope?
 *
 * Narrower than the exemption test below, which also covers the terminal
 * application's own units. Exported so the scan knows when a window-liveness probe
 * is worth doing, and so the naming rule lives in exactly one file — a second copy
 * of the regex in the caller is how the two would drift apart.
 *
 * Accepts a bare leaf name as well as a full path (a one-segment path is its leaf).
 */
export function isTerminalWindowScope(cgroupPath: string): boolean {
  const segs = segments(cgroupPath);
  return VTE_SCOPE_RE.test(segs[segs.length - 1] ?? '');
}

export interface ClassifyScopeOptions {
  /**
   * Is the terminal window that owns this scope still open? `undefined`/`null` mean
   * NOT PROBED / could not tell, and both leave the exemption intact.
   *
   * Only `false` — a positive observation that the window is gone — withdraws it.
   * The asymmetry is deliberate: a false DEAD would present the owner's live
   * terminal as unaccounted residue, so unknown must fail toward exempt.
   */
  terminalWindowAlive?: boolean | null;
}

/**
 * Classify one scanned process.
 *
 * `owned` short-circuits: a process inside our slice is ours regardless of what its
 * cgroup is named, and no exemption may override that. Terminal is checked BEFORE
 * the `.service` rule because `gnome-terminal-server.service` satisfies both and
 * "human terminal" is the more informative reason.
 *
 * Pure — no /proc reads, no clock. The scan supplies the inputs, window liveness
 * included; the probe that produces it lives in `terminal-window`.
 */
export function classifyScope(
  cgroupPath: string,
  owned: boolean,
  opts: ClassifyScopeOptions = {},
): ScopeClassification {
  if (owned) return { scope: 'owned', exemptReason: null };

  const segs = segments(cgroupPath);
  const leaf = segs[segs.length - 1] ?? '';
  const isWindow = VTE_SCOPE_RE.test(leaf);

  if (segs.includes(TERMINAL_SLICE) || isWindow) {
    // A closed window's scope is no longer "a lifetime the human owns" — it is
    // whatever an agent left running inside a window nobody is watching.
    if (isWindow && opts.terminalWindowAlive === false) {
      return { scope: 'abandoned-window', exemptReason: null };
    }
    return { scope: 'exempt', exemptReason: 'human-terminal' };
  }
  if (leaf.endsWith('.service')) {
    return { scope: 'exempt', exemptReason: 'systemd-unit' };
  }
  return { scope: 'unaccounted', exemptReason: null };
}

/** Human-facing label + one-line justification, so the pane never invents its own. */
export const EXEMPT_REASON_LABEL: Record<ExemptReason, { label: string; why: string }> = {
  'human-terminal': {
    label: 'human terminal',
    why: 'a terminal window the owner opened — the window is the unit of control, not the ledger',
  },
  'systemd-unit': {
    label: 'systemd unit',
    why: 'a .service unit — systemd owns its lifecycle (journal, stop, restart policy)',
  },
};
