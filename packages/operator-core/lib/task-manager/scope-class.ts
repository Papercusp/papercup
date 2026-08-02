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

export type ProcessScope = 'owned' | 'exempt' | 'unaccounted';

/** Why an out-of-slice process is not an escapee. Extend only with a structural rule. */
export type ExemptReason = 'human-terminal' | 'systemd-unit';

export interface ScopeClassification {
  scope: ProcessScope;
  /** Non-null exactly when `scope === 'exempt'`. */
  exemptReason: ExemptReason | null;
}

/** GNOME Terminal's app slice — every terminal WINDOW is a `vte-spawn-*.scope` under it. */
const TERMINAL_SLICE = 'app-org.gnome.Terminal.slice';
const VTE_SCOPE_RE = /^vte-spawn-[0-9a-fA-F-]+\.scope$/;

function segments(cgroupPath: string): string[] {
  return cgroupPath.split('/').filter(Boolean);
}

/**
 * Classify one scanned process.
 *
 * `owned` short-circuits: a process inside our slice is ours regardless of what its
 * cgroup is named, and no exemption may override that. Terminal is checked BEFORE
 * the `.service` rule because `gnome-terminal-server.service` satisfies both and
 * "human terminal" is the more informative reason.
 *
 * Pure — no /proc reads, no clock. The scan supplies the two inputs.
 */
export function classifyScope(cgroupPath: string, owned: boolean): ScopeClassification {
  if (owned) return { scope: 'owned', exemptReason: null };

  const segs = segments(cgroupPath);
  const leaf = segs[segs.length - 1] ?? '';

  if (segs.includes(TERMINAL_SLICE) || VTE_SCOPE_RE.test(leaf)) {
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
