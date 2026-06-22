/**
 * Left sidebar styles, as a JS string (NOT a .css import) — same rationale as
 * dev-admin-rail.styles.ts: a `.css` import leaks into the production sheet
 * even from a lazy chunk; an injected `<style>` tree-shakes with the module.
 *
 * The rail (left-sidebar-tauri-2026-06-07) is the desktop twin of the pui
 * dock's old main pane: Swarm / Voice / Hives as TABS. DOCKED on the LEFT —
 * it reserves layout space (body.has-left-sidebar padding-left + the
 * --left-sidebar-w var) so the app shifts right, sits AFTER the op-chat
 * sidebar (offset by --op-chat-w), collapses to a thin expand-rail, and is
 * drag-resizable from its RIGHT edge. Everything is prefixed pclsb.
 */
export const LEFT_SIDEBAR_CSS = `
.pclsb {
  --pclsb-current-accent: var(--accent, #38bdf8);
  position: fixed;
  top: 0;
  left: var(--op-chat-w, 0px); /* dock AFTER the op-chat sidebar */
  bottom: 0;
  z-index: 1290; /* just under the op-chat sidebar / dev rail layer */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    linear-gradient(90deg, color-mix(in oklab, var(--accent), transparent 94%), transparent 38%),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--bg-1, #0b1220), transparent 1%),
      color-mix(in srgb, var(--bg-deep, #050d18), transparent 0%)
    );
  border-right: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  box-shadow: 14px 0 38px rgba(0, 0, 0, 0.28);
}
.pclsb[data-tab="accounts"] {
  --pclsb-current-accent: #a78bfa;
}
.pclsb[data-tab="queen"] {
  --pclsb-current-accent: var(--warn, #fbbf24);
}
.pclsb[data-tab="overwatch"] {
  --pclsb-current-accent: #f87171;
}
.pclsb[data-tab="swarm"] {
  --pclsb-current-accent: var(--good, #4ade80);
}
.pclsb[data-tab="voice"] {
  --pclsb-current-accent: var(--accent, #38bdf8);
}
.pclsb[data-tab="hives"] {
  --pclsb-current-accent: var(--warn, #fbbf24);
}

/* Body reservation — the app shifts right by op-chat + this rail. This rule
   composes with (and must win over) the op-chat-only reservation; both default
   missing vars to 0px so the sides stay independent. */
body.has-left-sidebar {
  padding-left: calc(var(--op-chat-w, 0px) + var(--left-sidebar-w, 48px));
}
body.has-left-sidebar .pc-header {
  width: calc(100vw - var(--op-chat-w, 0px) - var(--left-sidebar-w, 0px) - var(--dev-rail-w, 0px));
}

/* Expanded shell — tab strip + active panel. Hidden when collapsed (panels
   are unmounted in the TSX) so an inactive tab's queries never run. */
.pclsb__expanded-shell {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pclsb[data-collapsed="true"] .pclsb__expanded-shell {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

/* Collapsed: a thin full-height rail with the three tab icons — clicking one
   expands straight into that tab. */
.pclsb__expand-rail {
  position: relative;
  z-index: 3;
  display: none;
  width: 100%;
  height: 100%;
  padding: 12px 6px 10px;
  align-items: center;
  flex-direction: column;
  gap: 10px;
}
.pclsb[data-collapsed="true"] .pclsb__expand-rail {
  display: flex;
}
.pclsb__rail-btn {
  --pclsb-tab-accent: var(--accent, #38bdf8);
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--pclsb-tab-accent), transparent 68%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), transparent 92%);
  color: color-mix(in oklab, var(--pclsb-tab-accent), var(--fg, #e7f7ff) 38%);
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__rail-btn:hover {
  border-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 34%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), transparent 82%);
  color: var(--fg, #e7f7ff);
}
.pclsb__rail-btn:focus-visible {
  outline: 1px solid color-mix(in oklab, var(--pclsb-tab-accent), transparent 18%);
  outline-offset: -2px;
}
.pclsb__rail-btn--accounts,
.pclsb__tab--accounts {
  --pclsb-tab-accent: #a78bfa;
}
.pclsb__rail-btn--queen,
.pclsb__tab--queen,
.pclsb__rail-btn--hives,
.pclsb__tab--hives {
  --pclsb-tab-accent: var(--warn, #fbbf24);
}
.pclsb__rail-btn--overwatch,
.pclsb__tab--overwatch {
  --pclsb-tab-accent: #f87171;
}
.pclsb__rail-btn--voice,
.pclsb__tab--voice,
.pclsb__rail-btn--expand {
  --pclsb-tab-accent: var(--accent, #38bdf8);
}
.pclsb__rail-btn--swarm,
.pclsb__tab--swarm {
  --pclsb-tab-accent: var(--good, #4ade80);
}

/* Header */
.pclsb__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-deep, #050d18), transparent 4%);
}
.pclsb__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 760;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb__title svg {
  color: var(--pclsb-current-accent);
}
.pclsb__spacer {
  flex: 1;
}
.pclsb__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__iconbtn:hover {
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
  color: var(--fg, #e7f7ff);
}

/* Tab strip — owner and fleet surfaces as compact accented tabs. */
.pclsb__tabs {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  padding: 8px 9px 7px;
  border-bottom: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-deep, #050d18), transparent 18%);
}
.pclsb__tab {
  --pclsb-tab-accent: var(--accent, #38bdf8);
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  padding: 7px 7px 6px;
  overflow: hidden;
  border-radius: 8px 8px 6px 6px;
  border: 1px solid color-mix(in oklab, var(--pclsb-tab-accent), transparent 70%);
  border-bottom-color: color-mix(in srgb, var(--border, rgba(125, 211, 252, 0.18)), transparent 12%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), var(--bg-2, #0b1220) 92%);
  color: var(--fg-dim, #b9d4e8);
  font-size: 11.5px;
  font-weight: 720;
  letter-spacing: 0;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__tab::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 3px;
  background: color-mix(in oklab, var(--pclsb-tab-accent), transparent 18%);
}
.pclsb__tab:hover {
  border-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 44%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), var(--bg-2, #0b1220) 84%);
  color: var(--fg, #e7f7ff);
}
.pclsb__tab.is-active {
  border-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 28%);
  border-bottom-color: color-mix(in oklab, var(--pclsb-tab-accent), transparent 36%);
  background: color-mix(in oklab, var(--pclsb-tab-accent), var(--bg-2, #0b1220) 76%);
  color: var(--fg, #e7f7ff);
}
.pclsb__tab.is-active::before {
  height: 4px;
  background: var(--pclsb-tab-accent);
}
.pclsb__tab-icon {
  position: relative;
  display: inline-flex;
  color: var(--pclsb-tab-accent);
  opacity: 0.96;
}
.pclsb__tab-label {
  position: relative;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Active panel body */
.pclsb__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 10px;
}

/* Drag-to-resize handle on the RIGHT edge (the rail is docked on the left). */
.pclsb__resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  background: transparent;
  z-index: 4;
  touch-action: none;
}
.pclsb__resize-handle:hover {
  background: linear-gradient(
    270deg,
    color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 78%),
    transparent
  );
}
.pclsb[data-collapsed="true"] .pclsb__resize-handle {
  display: none;
}

/* Panel primitives — shared by the three tabs (mirrors pcdar-panel). */
.pclsb-panel {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px 10px 12px;
}
.pclsb-panel__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}
.pclsb-panel__bar-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-panel__bar-spacer {
  flex: 1;
}
.pclsb-panel__empty {
  padding: 14px 10px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 36%);
  color: var(--fg-mute, #7f9bb4);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
/* EmptyState (components/ui/EmptyState.tsx) sub-elements — the container above
   provides the bordered, centered, muted shell; these style the optional
   icon / title / body slots. */
.pclsb-empty__icon {
  display: flex;
  justify-content: center;
  margin-bottom: 6px;
  color: var(--fg-mute, #7f9bb4);
  opacity: 0.7;
}
.pclsb-empty__title {
  font-size: 12px;
  font-weight: 680;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-empty__body {
  margin-top: 3px;
  font-size: 11px;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-panel__error {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in oklab, var(--bad, #f87171), transparent 64%);
  background: color-mix(in oklab, var(--bad, #f87171), transparent 91%);
  color: color-mix(in oklab, var(--bad, #f87171), var(--fg, #e7f7ff) 32%);
  font-size: 12px;
  line-height: 1.5;
}
.pclsb-chipbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 4px 8px;
  border-radius: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
  color: var(--fg-dim, #b9d4e8);
  font-size: 11px;
  font-weight: 680;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-chipbtn:hover {
  border-color: var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg, #e7f7ff);
}
.pclsb-chipbtn.is-on {
  background: color-mix(in oklab, var(--pclsb-current-accent), transparent 84%);
  border-color: color-mix(in oklab, var(--pclsb-current-accent), transparent 48%);
  color: var(--fg, #e7f7ff);
}

/* Rows (agents / hives / tasks / mail) */
.pclsb-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 11px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 28%);
  cursor: default;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-row + .pclsb-row {
  margin-top: 5px;
}
.pclsb-row.is-clickable {
  cursor: pointer;
}
.pclsb-row.is-clickable:hover {
  border-color: color-mix(in oklab, var(--pclsb-current-accent), transparent 58%);
  background: color-mix(in oklab, var(--pclsb-current-accent), transparent 92%);
}
.pclsb-row.is-selected {
  border-color: color-mix(in oklab, var(--pclsb-current-accent), transparent 36%);
  background: color-mix(in oklab, var(--pclsb-current-accent), transparent 86%);
  box-shadow: inset 3px 0 0 var(--pclsb-current-accent);
}
.pclsb-row__main {
  flex: 1;
  min-width: 0;
}
.pclsb-row__title {
  font-size: 13px;
  font-weight: 680;
  color: var(--fg, #e7f7ff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-row__sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-mute, #7f9bb4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-row__meta {
  margin-top: 2px;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  opacity: 0.85;
}
.pclsb-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--fg-mute, #7f9bb4);
}
.pclsb-dot.is-up {
  background: var(--good, #4ade80);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--good, #4ade80), transparent 82%);
}
.pclsb-dot.is-down {
  background: var(--bad, #f87171);
}
.pclsb-pill {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 7px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-pill--good {
  background: color-mix(in oklab, var(--good, #4ade80), transparent 85%);
  color: var(--good, #4ade80);
}
.pclsb-pill--warn {
  background: color-mix(in oklab, var(--warn, #fbbf24), transparent 85%);
  color: var(--warn, #fbbf24);
}
.pclsb-pill--bad {
  background: color-mix(in oklab, var(--bad, #f87171), transparent 85%);
  color: var(--bad, #f87171);
}
.pclsb-pill--neutral {
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  color: var(--fg-dim, #b9d4e8);
}

/* KVRow / DetailGrid (components/ui/KVRow.tsx) — a label→value detail list.
   DetailGrid is a <dl> stacking <div.pclsb-kv-row> rows, each holding a
   <dt> label (muted, left) and a <dd> value (mono, right). Mirrors .pcdar-kv. */
.pclsb-detail-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  font-size: 12px;
}
.pclsb-kv-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.pclsb-kv-row__label {
  flex: 0 0 auto;
  color: var(--fg-mute, #7f9bb4);
}
.pclsb-kv-row__value {
  flex: 1 1 auto;
  margin: 0;
  min-width: 0;
  color: var(--fg, #e7f7ff);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Per-hive start/stop control — mirrors the in-page AdvNowRunning "Start hive"
   / "Stop hive" actions (pc-advshell__action--start/stop): a bordered,
   uppercase, color-coded pill (green start, red stop) with a hover lift, sized
   for the compact sidebar row. Replaces the flat .pclsb-pill badge so the
   sidebar toggle reads as the same control as the one inside a hive page. */
.pclsb-hivebtn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 7px;
  border: 1px solid transparent;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-hivebtn:disabled {
  opacity: 0.55;
  cursor: default;
}
.pclsb-hivebtn--start {
  background: rgba(34, 197, 94, 0.16);
  color: #86efac;
  border-color: rgba(34, 197, 94, 0.38);
}
.pclsb-hivebtn--start:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.26);
}
.pclsb-hivebtn--stop {
  background: rgba(239, 68, 68, 0.12);
  color: #fca5a5;
  border-color: rgba(239, 68, 68, 0.34);
}
.pclsb-hivebtn--stop:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.22);
}

/* Section headers inside a tab (task list / plan progress / comms). */
.pclsb-sec {
  margin-top: 9px;
  padding: 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 44%);
}
.pclsb-sec__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--fg-mute, #7f9bb4);
  padding: 0 1px 7px;
}
.pclsb-task {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 4px 5px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-task:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
}
.pclsb-task__rank {
  flex: 0 0 34px;
  color: var(--fg-mute, #7f9bb4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}
.pclsb-task__title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-task__st {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
}

/* Plan progress bars */
.pclsb-plan {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 5px;
  border-radius: 8px;
  font-size: 12px;
}
.pclsb-plan:hover {
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
}
.pclsb-plan__slug {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg-dim, #b9d4e8);
}
.pclsb-plan__bar {
  flex: 0 0 90px;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-3, rgba(255, 255, 255, 0.075));
  overflow: hidden;
}
.pclsb-plan__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--pclsb-current-accent);
}
.pclsb-plan__nums {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Mail / conversation lines (comms view) */
.pclsb-mail {
  padding: 6px 7px;
  border-radius: 9px;
  font-size: 12px;
  color: var(--fg-dim, #b9d4e8);
  background: var(--bg-2, rgba(255, 255, 255, 0.045));
}
.pclsb-mail__meta {
  font-size: 10px;
  color: var(--fg-mute, #7f9bb4);
}

/* The Voice tab's video region wants the full panel height. */
.pclsb-voice {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.pclsb-voice__bar {
  padding: 8px 10px 2px;
}
.pclsb-voice__channels {
  margin: 6px 10px 8px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-1, #0b1220), transparent 34%);
  overflow: hidden;
}
.pclsb-voice__grid {
  flex: 1;
  min-height: 220px;
  margin: 0 10px 10px;
  border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
  border-radius: 12px;
  background: var(--bg-deep, #050d18);
  overflow: hidden;
}
.pclsb-voice__empty {
  margin: 10px;
  padding: 18px 14px;
}

/* OverwatchTab (overwatch supervisor panel) */
.pc-owsb { display: flex; flex-direction: column; gap: 8px; padding: 10px 10px 16px; min-height: 0; }
.pc-owsb--empty { padding-top: 24px; }
.pc-owsb__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11.5px; line-height: 1.4; padding: 8px 2px; }
.pc-owsb__bar { display: flex; align-items: center; gap: 7px; padding: 8px 9px; border-radius: 9px; border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); }
.pc-owsb__bar[data-tone='good'] { border-color: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.06); }
.pc-owsb__bar[data-tone='warn'] { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.06); }
.pc-owsb__bar svg { color: var(--fg-dim, #b9d4e8); }
.pc-owsb__identity { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1; }
.pc-owsb__state { display: flex; flex-direction: column; min-width: 0; line-height: 1.1; }
.pc-owsb__title { font-size: 12px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; color: var(--fg, #e7f7ff); }
.pc-owsb__subtitle { font-size: 9.5px; color: var(--fg-mute, #7f9bb4); letter-spacing: 0; margin-top: 2px; }
.pc-owsb__hive { font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4); padding: 2px 7px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 86px; flex-shrink: 1; }
.pc-owsb__toggle { display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; flex-shrink: 0; font-size: 9.5px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; min-width: 62px; padding: 4px 9px; border-radius: 999px; color: var(--fg, #e7f7ff); border: 1px solid rgba(125, 211, 252, 0.3); background: rgba(255, 255, 255, 0.05); }
.pc-owsb__toggle:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
.pc-owsb__toggle:disabled { opacity: 0.55; cursor: default; }
.pc-owsb__toggle[data-on='true'] { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.1); }
.pc-owsb__toggle[data-on='false'] { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.5); background: rgba(52, 211, 153, 0.1); }
.pc-owsb__toggle svg { display: block; }
.pc-owsb__dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.pc-owsb__dot--good { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.7); }
.pc-owsb__dot--warn { background: #fbbf24; box-shadow: 0 0 5px rgba(251, 191, 36, 0.6); }
.pc-owsb__dot--mute { background: #475569; }
.pc-owsb__metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.pc-owsb__metric { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 6px 7px; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: rgba(255, 255, 255, 0.025); }
.pc-owsb__metric-icon { display: inline-flex; align-items: center; justify-content: center; color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
.pc-owsb__metric-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pc-owsb__metric-label { font-size: 8.5px; font-weight: 760; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
.pc-owsb__metric-value { font-size: 10.5px; font-weight: 720; color: var(--fg-dim, #b9d4e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.pc-owsb__metric--good { border-color: rgba(52, 211, 153, 0.28); background: rgba(52, 211, 153, 0.055); }
.pc-owsb__metric--good .pc-owsb__metric-value, .pc-owsb__metric--good .pc-owsb__metric-icon { color: #6ee7b7; }
.pc-owsb__metric--warn { border-color: rgba(251, 191, 36, 0.3); background: rgba(251, 191, 36, 0.06); }
.pc-owsb__metric--warn .pc-owsb__metric-value, .pc-owsb__metric--warn .pc-owsb__metric-icon { color: #fcd34d; }
.pc-owsb__metric--bad { border-color: rgba(244, 63, 94, 0.34); background: rgba(244, 63, 94, 0.065); }
.pc-owsb__metric--bad .pc-owsb__metric-value, .pc-owsb__metric--bad .pc-owsb__metric-icon { color: #fca5a5; }
.pc-owsb__metric--mute .pc-owsb__metric-value { color: var(--fg-dim, #b9d4e8); }
.pc-owsb__empty-title { font-size: 10.5px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; color: var(--fg, #e7f7ff); }
.pc-owsb__err { font-size: 10.5px; line-height: 1.35; color: #fca5a5; padding: 6px 9px; border-radius: 8px; border: 1px solid rgba(244, 63, 94, 0.4); background: rgba(244, 63, 94, 0.08); }
.pc-owsb__hint { font-size: 10px; line-height: 1.4; color: #fcd34d; padding: 6px 9px; border-radius: 8px; border: 1px solid rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.07); }
.pc-owsb__hint strong { color: #fde68a; font-weight: 760; }
.pc-owsb__section { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); background: var(--bg-2, rgba(255, 255, 255, 0.03)); }
.pc-owsb__section--empty { gap: 2px; }
.pc-owsb__section-head { display: flex; align-items: center; gap: 6px; }
.pc-owsb__section-head svg { color: var(--fg-mute, #7f9bb4); }
.pc-owsb__section-title { font-size: 10.5px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; color: var(--fg, #e7f7ff); }
.pc-owsb__counts { margin-left: auto; display: flex; gap: 4px; }
.pc-owsb__count { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); color: var(--fg-mute, #7f9bb4); }
.pc-owsb__count--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); background: rgba(244, 63, 94, 0.12); }
.pc-owsb__count--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.12); }
.pc-owsb__count--good { color: #6ee7b7; border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.1); }
.pc-owsb__filters { display: flex; gap: 4px; flex-wrap: wrap; }
.pc-owsb__chip { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; cursor: pointer; padding: 3px 8px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); background: var(--bg-3, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); }
.pc-owsb__chip:hover { color: var(--fg, #e7f7ff); border-color: rgba(125, 211, 252, 0.34); }
.pc-owsb__chip--on { color: var(--fg, #e7f7ff); border-color: rgba(99, 102, 241, 0.6); background: rgba(99, 102, 241, 0.16); }
.pc-owsb__healthy { font-size: 11px; color: #6ee7b7; padding: 9px 10px; border-radius: 8px; border: 1px solid rgba(52, 211, 153, 0.3); background: rgba(52, 211, 153, 0.07); }
.pc-owsb__anoms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow-y: auto; }
.pc-owsb__anom { display: flex; flex-direction: column; gap: 5px; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); border-left: 3px solid var(--accent, #475569); background: rgba(255, 255, 255, 0.02); }
.pc-owsb__anom--bad { --accent: #f43f5e; background: rgba(244, 63, 94, 0.06); }
.pc-owsb__anom--warn { --accent: #fbbf24; background: rgba(251, 191, 36, 0.05); }
.pc-owsb__anom--mute { --accent: var(--accent, #38bdf8); }
.pc-owsb__anom-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pc-owsb__anom-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.pc-owsb__sev { font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; padding: 1px 6px; border-radius: 999px; }
.pc-owsb__sev--bad { color: #fca5a5; background: rgba(244, 63, 94, 0.16); }
.pc-owsb__sev--warn { color: #fcd34d; background: rgba(251, 191, 36, 0.16); }
.pc-owsb__sev--mute { color: var(--accent-soft, var(--fg-dim, #b9d4e8)); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%); }
.pc-owsb__kind { font-size: 10.5px; font-weight: 750; color: var(--fg, #e7f7ff); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pc-owsb__subject { flex-shrink: 0; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; color: var(--fg-mute, #7f9bb4); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pc-owsb__action { display: flex; align-items: center; gap: 7px; min-width: 0; padding-top: 2px; border-top: 1px solid color-mix(in oklab, var(--border, rgba(125, 211, 252, 0.18)), transparent 45%); }
.pc-owsb__verb { flex-shrink: 0; font-size: 8.5px; font-weight: 800; letter-spacing: 0; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.pc-owsb__verb--nudge { color: #818cf8; }
.pc-owsb__verb--observe { color: var(--accent, #38bdf8); }
.pc-owsb__verb--escalate { color: #fb7185; }
.pc-owsb__anom-detail { font-size: 11px; line-height: 1.35; color: var(--fg-dim, #b9d4e8); }
.pc-owsb__anom-msg { min-width: 0; font-size: 10.5px; line-height: 1.35; color: var(--fg-mute, #7f9bb4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-owsb__footnote { font-size: 10px; line-height: 1.4; color: var(--fg-mute, #7f9bb4); padding: 0 2px; }
.pc-owsb__footnote strong { color: var(--fg-dim, #b9d4e8); font-weight: 700; }

/* QueenTab (steering panel) + QueenHeartbeat + ModelTiersOverride */
.pc-queen { --queen-accent: var(--warn, #fbbf24); display: flex; flex-direction: column; gap: 8px; padding: 9px 9px 14px; min-height: 0; }
.pc-queen__placeholder { color: var(--fg-mute, #7f9bb4); font-size: 11px; padding: 7px 2px; }
.pc-queen__bar { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 7px; padding: 2px 1px 4px; border-bottom: 1px solid color-mix(in srgb, var(--queen-accent), transparent 84%); }
.pc-queen__bar svg { color: var(--queen-accent); }
.pc-queen__identity { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pc-queen__title { font-size: 13px; font-weight: 780; letter-spacing: 0; color: var(--fg, #e7f7ff); line-height: 1.05; }
.pc-queen__subtitle { font-size: 10px; color: var(--fg-mute, #7f9bb4); line-height: 1.1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__hive { font-size: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4); padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 94px; }
.pc-queen__spacer { flex: 1; }
.pc-queen__reset { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; letter-spacing: 0; padding: 4px 7px; border-radius: 6px; cursor: pointer; color: var(--fg-dim, #b9d4e8); background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); }
.pc-queen__reset:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 52%); }
.pc-queen__reset:disabled { opacity: 0.5; cursor: default; }
.pc-queen__reset:focus-visible, .pc-queen__btn:focus-visible, .pc-queen__chip:focus-visible, .pc-queen__check:focus-visible { outline: 1px solid var(--queen-accent); outline-offset: 1px; }
.pc-queen__summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
.pc-queen__summary-item { min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 6px 7px; border-radius: 7px; border: 1px solid var(--border, rgba(125, 211, 252, 0.16)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); }
.pc-queen__summary-item--good { border-color: color-mix(in srgb, var(--good, #34d399), transparent 62%); background: color-mix(in srgb, var(--good, #34d399), transparent 91%); }
.pc-queen__summary-item--warn { border-color: color-mix(in srgb, var(--queen-accent), transparent 58%); background: color-mix(in srgb, var(--queen-accent), transparent 90%); }
.pc-queen__summary-label { font-size: 9.5px; font-weight: 720; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
.pc-queen__summary-value { min-width: 0; font-size: 11px; font-weight: 680; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__err { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #fca5a5; padding: 6px 9px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--bad, #f43f5e), transparent 58%); background: color-mix(in srgb, var(--bad, #f43f5e), transparent 90%); }
.pc-queen__section { display: flex; flex-direction: column; gap: 7px; padding: 8px 9px; border-radius: 8px; border: 1px solid var(--border, rgba(125, 211, 252, 0.14)); border-left-color: color-mix(in srgb, var(--queen-accent), transparent 48%); background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.04)), transparent 18%); }
.pc-queen__section--pause { border-color: color-mix(in srgb, var(--queen-accent), transparent 68%); border-left-color: var(--queen-accent); }
.pc-queen__section-head { display: flex; align-items: center; gap: 6px; }
.pc-queen__section-head svg { color: var(--fg-mute, #7f9bb4); }
.pc-queen__section-title { font-size: 11px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
.pc-queen__count { margin-left: auto; font-size: 9.5px; color: var(--fg-mute, #7f9bb4); text-align: right; }
.pc-queen__btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-size: 11.5px; font-weight: 720; padding: 7px 10px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.pc-queen__btn--block { width: 100%; }
.pc-queen__btn:disabled { opacity: 0.55; cursor: default; }
.pc-queen__btn--go { background: color-mix(in srgb, var(--queen-accent), transparent 86%); color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 54%); }
.pc-queen__btn--stop { background: color-mix(in srgb, var(--good, #34d399), transparent 86%); color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--good, #34d399), transparent 58%); }
.pc-queen__btn--save { background: color-mix(in srgb, var(--accent), transparent 86%); color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--accent), transparent 58%); }
.pc-queen__btn:hover:not(:disabled), .pc-queen__chip:hover:not(:disabled) { color: var(--fg, #e7f7ff); border-color: color-mix(in srgb, var(--queen-accent), transparent 48%); background: color-mix(in srgb, var(--queen-accent), transparent 88%); }
.pc-queen__chip { font-size: 10px; font-weight: 700; padding: 4px 8px; border-radius: 6px; cursor: pointer; color: var(--fg-dim, #b9d4e8); background: var(--bg-3, rgba(255, 255, 255, 0.05)); border: 1px solid var(--border, rgba(125, 211, 252, 0.22)); }
.pc-queen__chip:disabled { opacity: 0.5; cursor: default; }
.pc-queen__pausebadge { margin-left: auto; font-size: 9.5px; font-weight: 700; padding: 2px 7px; border-radius: 999px; color: var(--fg, #e7f7ff); border: 1px solid color-mix(in srgb, var(--good, #34d399), transparent 58%); background: color-mix(in srgb, var(--good, #34d399), transparent 90%); }
.pc-queen__pausebadge--on { border-color: color-mix(in srgb, var(--queen-accent), transparent 50%); background: color-mix(in srgb, var(--queen-accent), transparent 88%); }
.pc-queen__pausefor { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pc-queen__duration { display: inline-flex; align-items: center; gap: 5px; min-height: 27px; padding: 2px 6px; border-radius: 7px; border: 1px solid var(--border, rgba(125, 211, 252, 0.18)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); }
.pc-queen__presetlabel { font-size: 10px; letter-spacing: 0; color: var(--fg-mute, #7f9bb4); }
.pc-queen__mins { width: 48px; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); }
.pc-queen__mins:focus { outline: none; border-color: color-mix(in srgb, var(--queen-accent), transparent 35%); }
.pc-queen__hint { font-size: 10px; line-height: 1.3; color: var(--fg-mute, #7f9bb4); }
.pc-queen__scope { font-size: 10.5px; line-height: 1.35; color: var(--fg-dim, #b9d4e8); padding: 6px 8px; border-radius: 7px; background: color-mix(in srgb, var(--accent), transparent 94%); border: 1px solid color-mix(in srgb, var(--accent), transparent 82%); }
.pc-queen__scope--restricted { color: var(--fg, #e7f7ff); background: color-mix(in srgb, var(--queen-accent), transparent 91%); border-color: color-mix(in srgb, var(--queen-accent), transparent 68%); }
.pc-queen__plans { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 260px; overflow-y: auto; }
.pc-queen__plan { display: flex; align-items: center; gap: 7px; padding: 5px 7px; border-radius: 7px; border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02); }
.pc-queen__plan--on { border-color: color-mix(in srgb, var(--queen-accent), transparent 58%); background: color-mix(in srgb, var(--queen-accent), transparent 93%); }
.pc-queen__planlabel { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.pc-queen__check { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; padding: 0; cursor: pointer; color: var(--accent-ink, #051827); background: var(--bg-2, rgba(255, 255, 255, 0.04)); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); border-radius: 4px; flex-shrink: 0; }
.pc-queen__check[data-state='checked'], .pc-queen__check[data-state='indeterminate'] { background: var(--queen-accent); border-color: var(--queen-accent); }
.pc-queen__check:disabled { cursor: default; opacity: 0.5; }
.pc-queen__check svg { width: 10px; height: 10px; }
.pc-queen__planslug { font-size: 11.5px; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__planstatus { flex-shrink: 0; font-size: 8.5px; font-weight: 700; letter-spacing: 0; padding: 1px 6px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); }
.pc-queen__planstatus[data-status='started'] { color: #86efac; border-color: color-mix(in srgb, var(--good, #34d399), transparent 56%); }
.pc-queen__planstatus[data-status='active'] { color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent), transparent 60%); }
.pc-queen__planstatus[data-status='stale'] { color: #fca5a5; border-color: color-mix(in srgb, var(--bad, #f43f5e), transparent 56%); }
.pc-queen__directive { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 11.5px; line-height: 1.4; min-height: 74px; padding: 7px 9px; border-radius: 7px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); }
.pc-queen__directive::placeholder { color: var(--fg-mute, #7f9bb4); }
.pc-queen__directive:focus { outline: none; border-color: color-mix(in srgb, var(--accent), transparent 42%); }
.pc-queen__directive-actions { display: flex; align-items: center; gap: 7px; }

/* QueenHeartbeat (Queen status indicator) */
.pc-qh { display: flex; flex-direction: column; gap: 5px; padding: 9px 10px; border-radius: 10px; border: 1px solid var(--qh-accent, rgba(125, 211, 252, 0.2)); background: var(--bg-2, rgba(255, 255, 255, 0.04)); }
.pc-qh--live { --qh-accent: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.09); }
.pc-qh--ok { --qh-accent: rgba(52, 211, 153, 0.4); background: rgba(52, 211, 153, 0.055); }
.pc-qh--warn { --qh-accent: rgba(251, 191, 36, 0.5); background: rgba(251, 191, 36, 0.08); }
.pc-qh--mute { --qh-accent: color-mix(in oklab, var(--accent, #38bdf8), transparent 82%); }
.pc-qh__top { display: flex; align-items: center; gap: 7px; }
.pc-qh__top svg { color: #fbbf24; }
.pc-qh__dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.pc-qh__dot--live { background: #34d399; box-shadow: 0 0 7px rgba(52, 211, 153, 0.8); }
.pc-qh__dot--ok { background: #34d399; box-shadow: 0 0 5px rgba(52, 211, 153, 0.6); }
.pc-qh__dot--warn { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.7); }
.pc-qh__dot--mute { background: #475569; }
.pc-qh__dot--pulse { animation: pc-qh-pulse 1.7s ease-in-out infinite; }
@keyframes pc-qh-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.82); } }
.pc-qh__state { font-size: 11.5px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
.pc-qh__slug { margin-left: auto; font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #7f9bb4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 110px; }
.pc-qh__wakes { display: flex; gap: 10px; flex-wrap: wrap; }
.pc-qh__woke, .pc-qh__next { font-size: 10.5px; color: var(--fg-dim, #b9d4e8); font-variant-numeric: tabular-nums; }
.pc-qh__next { color: var(--fg-mute, #7f9bb4); }
.pc-qh__placements { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
.pc-qh__pchip { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; padding: 1px 7px; border-radius: 999px; color: var(--fg-dim, #b9d4e8); border: 1px solid var(--border, rgba(125, 211, 252, 0.22)); background: rgba(255, 255, 255, 0.03); }
.pc-qh__pchip--warn { color: #fcd34d; border-color: rgba(251, 191, 36, 0.5); }
.pc-qh__pchip--bad { color: #fca5a5; border-color: rgba(244, 63, 94, 0.5); }
.pc-qh__pchip--idle { color: var(--fg-mute, #7f9bb4); opacity: 0.8; }
.pc-qh__wi { font-size: 9px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #fcd34d; padding: 1px 6px; border-radius: 5px; background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.35); }

/* ModelTiersOverride (model tier configuration) */
.pc-mt { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.pc-mt__row { display: flex; align-items: center; gap: 6px; padding: 4px 7px; border-radius: 7px; border: 1px solid var(--border, rgba(125, 211, 252, 0.12)); background: rgba(255, 255, 255, 0.02); }
.pc-mt__row--on { border-color: rgba(99, 102, 241, 0.45); background: rgba(99, 102, 241, 0.08); }
.pc-mt__name { flex-shrink: 0; width: 58px; font-size: 10.5px; font-weight: 700; color: var(--fg, #e7f7ff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-mt__spec { flex: 1; min-width: 0; font: inherit; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: 3px 6px; border-radius: 5px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.28)); }
.pc-mt__spec:focus { outline: none; border-color: rgba(99, 102, 241, 0.6); }
.pc-mt__spec:disabled { opacity: 0.6; }
/* The per-tier badge + reset now render through the shared <OverridableSetting>
 * (badgeStyle="chip" → .pc-override-badge / .pc-override-reset), so the old
 * .pc-mt__badge / .pc-mt__reset classes are gone. The row container + name + spec
 * input styling below stays — it wraps the primitive. */

/* ThrottleSection + AutonomySurfacing (queen-steering-panel P-007 / P-009) */
.pc-queen__collapse { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; background: none; border: none; cursor: pointer; text-align: left; color: inherit; font: inherit; }
.pc-queen__collapse svg { color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
.pc-queen__collapse:hover .pc-queen__section-title { color: var(--fg, #e7f7ff); }
.pc-queen__collapse:focus-visible { outline: 1px solid var(--queen-accent); outline-offset: 2px; border-radius: 5px; }
.pc-queen__count--on { color: #fcd34d; font-weight: 700; }
.pc-queen__chip--on { color: var(--fg, #e7f7ff); background: color-mix(in srgb, var(--queen-accent), transparent 82%); border-color: color-mix(in srgb, var(--queen-accent), transparent 46%); }
.pc-queen__knobs { display: flex; flex-direction: column; gap: 9px; }
.pc-queen__knob { display: flex; flex-direction: column; gap: 5px; }
.pc-queen__knobhead { display: flex; align-items: center; gap: 6px; }
.pc-queen__knobhead svg { color: var(--fg-mute, #7f9bb4); flex-shrink: 0; }
.pc-queen__knoblabel { font-size: 11px; font-weight: 700; color: var(--fg, #e7f7ff); }
/* When a knob head hosts the shared <OverridableSetting> (badgeStyle="inline"),
 * let it grow to fill the head so the badge's margin-left:auto right-aligns it
 * exactly like the old .pc-queen__knobbadge. */
.pc-queen__knobhead .pc-override { flex: 1; min-width: 0; }
.pc-queen__knobbadge { margin-left: auto; font-size: 8px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; padding: 1px 6px; border-radius: 999px; color: var(--fg-mute, #7f9bb4); border: 1px solid var(--border, rgba(125, 211, 252, 0.2)); }
.pc-queen__knobbadge--on { color: #fcd34d; border-color: color-mix(in srgb, var(--queen-accent), transparent 50%); background: color-mix(in srgb, var(--queen-accent), transparent 88%); }
.pc-queen__knobrow { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.pc-queen__num { width: 62px; font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 5px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); }
.pc-queen__num:focus { outline: none; border-color: color-mix(in srgb, var(--queen-accent), transparent 35%); }
.pc-queen__num:disabled { opacity: 0.6; }
.pc-queen__select { width: 100%; font: inherit; font-size: 11.5px; padding: 5px 7px; border-radius: 6px; color: var(--fg, #e7f7ff); background: var(--bg, #07101d); border: 1px solid var(--border-strong, rgba(125, 211, 252, 0.3)); cursor: pointer; }
.pc-queen__select:focus { outline: none; border-color: color-mix(in srgb, var(--queen-accent), transparent 35%); }
.pc-queen__select:disabled { opacity: 0.6; cursor: default; }
.pc-queen__toggles { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.pc-queen__toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg, #e7f7ff); cursor: pointer; }
.pc-queen__toggle--off { color: var(--fg-mute, #7f9bb4); }
.pc-queen__seg { display: flex; flex-wrap: wrap; gap: 4px; }
.pc-queen__catlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 168px; overflow-y: auto; }
.pc-queen__cat { display: flex; align-items: center; gap: 7px; padding: 3px 7px; border-radius: 6px; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border, rgba(125, 211, 252, 0.1)); }
.pc-queen__cat--more { justify-content: center; color: var(--fg-mute, #7f9bb4); font-size: 10px; background: none; border: none; }
.pc-queen__catlabel { flex: 1; min-width: 0; font-size: 11px; color: var(--fg-dim, #b9d4e8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-queen__catceil { flex-shrink: 0; font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0; padding: 1px 6px; border-radius: 999px; color: var(--accent-soft, #7dd3fc); border: 1px solid color-mix(in srgb, var(--accent), transparent 60%); }

/* AccountsTab (account-pool panel) — moved from inline ACCT_CSS (WI-219 U3, SwarmTab pattern) */
.pclsb-acct { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 12px; font-size: 12px; color: var(--fg, #e7e7ea); }
.pclsb-acct__hero {
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 8px 9px; border-radius: 8px;
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.045)) 88%, var(--accent, #8b5cf6) 12%);
  border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 24%, var(--border, rgba(255, 255, 255, 0.12)));
}
.pclsb-acct__herotitle { display: flex; align-items: center; gap: 7px; min-width: 0; }
.pclsb-acct__herotitle svg { flex: 0 0 auto; color: var(--accent, #8b5cf6); }
.pclsb-acct__hero p { margin: 1px 0 0; font-size: 10.5px; line-height: 1.25; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__eyebrow { display: block; font-size: 9.5px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; color: var(--fg, #e7e7ea); }
.pclsb-acct__summary { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-width: 0; }
.pclsb-acct__summary span {
  display: inline-flex; align-items: baseline; gap: 3px; min-width: 0; padding: 2px 5px; border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1)); background: var(--bg-2, rgba(255, 255, 255, 0.035));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9.5px; font-weight: 650; color: var(--fg-mute, #a6a6ad);
}
.pclsb-acct__summary b { color: var(--fg, #e7e7ea); font-variant-numeric: tabular-nums; }
.pclsb-acct__rule {
  padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  background: color-mix(in srgb, var(--bg-2, rgba(255, 255, 255, 0.035)) 82%, transparent);
  font-size: 10px; line-height: 1.25; color: var(--fg-mute, #a6a6ad);
}
.pclsb-acct__rule strong { color: var(--fg, #e7e7ea); font-weight: 700; }
.pclsb-acct__ovr { display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px; border-radius: 8px;
  background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent, #8b5cf6) 35%, transparent); }
.pclsb-acct__ovrtext { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 3px 5px; font-size: 10px; line-height: 1.45; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__ovrtext > strong { color: var(--fg, #e7e7ea); font-size: 10.5px; }
.pclsb-acct__clear {
  flex: 0 0 auto; align-self: center; font-size: 10.5px; padding: 2px 7px; border-radius: 6px; cursor: pointer;
  color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 8%, transparent); border: 1px solid var(--accent, #8b5cf6);
}
.pclsb-acct__clear:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.pclsb-acct__row {
  display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-radius: 8px;
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.pclsb-acct__row--paused { border-color: color-mix(in srgb, var(--warn, #fbbf24) 35%, transparent); }
.pclsb-acct__row--off { opacity: 0.82; }
.pclsb-acct__row.is-forced { border-color: color-mix(in srgb, var(--accent, #8b5cf6) 42%, transparent); }
.pclsb-acct__row.is-excluded { border-color: color-mix(in srgb, var(--warn, #fbbf24) 42%, transparent); }
.pclsb-acct__top { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 4px 6px; }
.pclsb-acct__dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-mute, #8a8a91); }
.pclsb-acct__dot--ok { background: var(--good, #34d399); }
.pclsb-acct__dot--paused { background: var(--warn, #fbbf24); }
.pclsb-acct__dot--off { background: var(--bad, #f87171); }
.pclsb-acct__name { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; align-items: flex-start;
  background: transparent; border: none; cursor: pointer; text-align: left; padding: 0; color: inherit; font: inherit; }
.pclsb-acct__labelrow { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; }
.pclsb-acct__label { font-size: 11.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.pclsb-acct__provider { flex: 0 0 auto; display: inline-flex; align-items: center; height: 15px; padding: 0 5px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--fg-mute, #8a8a91) 34%, transparent); color: var(--fg-mute, #8a8a91); font-size: 8.5px; font-weight: 750; text-transform: uppercase; line-height: 1; letter-spacing: 0; }
.pclsb-acct__provider--codex { color: var(--accent-cool, #c4b5fd); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 45%, transparent); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__id { margin-top: -1px; font-size: 9.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__statuspill {
  justify-self: end; display: inline-flex; align-items: center; max-width: 82px; min-height: 18px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12)); background: var(--bg-3, rgba(255, 255, 255, 0.06));
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; font-weight: 720; color: var(--fg-mute, #c2c2c9);
}
.pclsb-acct__statuspill--ok { color: var(--good, #34d399); border-color: color-mix(in srgb, var(--good, #34d399) 38%, transparent); background: color-mix(in srgb, var(--good, #34d399) 10%, transparent); }
.pclsb-acct__statuspill--paused { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 38%, transparent); background: color-mix(in srgb, var(--warn, #fbbf24) 10%, transparent); }
.pclsb-acct__statuspill--off { color: var(--bad, #f87171); border-color: color-mix(in srgb, var(--bad, #f87171) 38%, transparent); background: color-mix(in srgb, var(--bad, #f87171) 10%, transparent); }
.pclsb-acct__btns { display: flex; gap: 3px; flex: 0 0 auto; align-items: center; justify-content: flex-end; }
.pclsb-acct__b {
  font-size: 10px; padding: 1px 6px; min-height: 19px; border-radius: 6px; cursor: pointer; color: var(--fg-mute, #c2c2c9);
  background: var(--bg-2, rgba(255, 255, 255, 0.035)); border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__b:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__b:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__b.is-force { color: var(--accent, #8b5cf6); border-color: var(--accent, #8b5cf6); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__b.is-excl { color: var(--warn, #fbbf24); border-color: var(--warn, #fbbf24); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
.pclsb-acct__expand { display: inline-flex; align-items: center; justify-content: center; padding: 1px; min-width: 18px; min-height: 18px; border-radius: 5px;
  background: transparent; border: none; cursor: pointer; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__expand:hover { color: var(--fg, #e7e7ea); }
.pclsb-acct__usage { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 5px; font-size: 10px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__meter {
  min-width: 0; display: grid; grid-template-columns: auto minmax(22px, 1fr) auto; align-items: center; gap: 4px;
  padding: 0; border-radius: 0; border: 0; background: transparent;
}
.pclsb-acct__meterlabel { font-size: 9px; font-weight: 720; letter-spacing: 0; text-transform: uppercase; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__meter strong { font-size: 9.5px; color: var(--fg, #e7e7ea); font-variant-numeric: tabular-nums; }
.pclsb-acct__bar { height: 3px; overflow: hidden; border-radius: 999px; background: var(--bg-3, rgba(255, 255, 255, 0.07)); }
.pclsb-acct__bar span { display: block; height: 100%; border-radius: inherit; background: var(--fg-mute, #8a8a91); }
.pclsb-acct__meter--ok .pclsb-acct__bar span { background: var(--good, #34d399); }
.pclsb-acct__meter--warn .pclsb-acct__bar span { background: var(--warn, #fbbf24); }
.pclsb-acct__meter--hot .pclsb-acct__bar span { background: var(--bad, #f87171); }
.pclsb-acct__meterreset { grid-column: 2 / 4; margin-top: -2px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute, #77777f); font-size: 8.5px; }
.pclsb-acct__facts { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 5px; min-width: 0; font-size: 9.5px; line-height: 1.25; color: var(--fg-mute, #8a8a91); }
.pclsb-acct__facts > span:not(.pclsb-acct__chip) { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pclsb-acct__facts > span:not(.pclsb-acct__chip)::after { content: "·"; margin-left: 5px; color: color-mix(in srgb, var(--fg-mute, #8a8a91) 45%, transparent); }
.pclsb-acct__facts > span:not(.pclsb-acct__chip):last-child::after { content: ""; margin-left: 0; }
.pclsb-acct__umute { color: var(--fg-mute, #8a8a91); }
.pclsb-acct__chip { display: inline-flex; padding: 0 5px; border-radius: 999px; font-size: 9px; font-weight: 650;
  background: var(--bg-3, rgba(255, 255, 255, 0.06)); color: var(--fg-mute, #c2c2c9); border: 1px solid var(--border, rgba(255, 255, 255, 0.1)); }
.pclsb-acct__chip.is-force { color: var(--accent, #8b5cf6); border-color: color-mix(in srgb, var(--accent, #8b5cf6) 45%, transparent); background: color-mix(in srgb, var(--accent, #8b5cf6) 12%, transparent); }
.pclsb-acct__chip.is-excl { color: var(--warn, #fbbf24); border-color: color-mix(in srgb, var(--warn, #fbbf24) 45%, transparent); background: color-mix(in srgb, var(--warn, #fbbf24) 12%, transparent); }
.pclsb-acct__detail { display: flex; flex-direction: column; gap: 6px; padding-top: 5px; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); }
.pclsb-acct__status { display: flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--fg-mute, #c2c2c9); }
.pclsb-acct__status--ok { color: var(--good, #34d399); }
.pclsb-acct__status--paused { color: var(--warn, #fbbf24); }
.pclsb-acct__status--off { color: var(--bad, #f87171); }
.pclsb-acct__meta { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.pclsb-acct__meta > div { display: grid; grid-template-columns: 58px 1fr; gap: 8px; align-items: baseline; }
.pclsb-acct__meta dt { margin: 0; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0; color: var(--fg-mute, #8a8a91); display: inline-flex; align-items: center; gap: 3px; }
.pclsb-acct__meta dd { margin: 0; font-size: 10.5px; color: var(--fg, #e7e7ea); min-width: 0; }
.pclsb-acct__bound { display: inline-flex; flex-wrap: wrap; gap: 3px; }
.pclsb-acct__cred { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; color: var(--fg-mute, #a6a6ad);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
.pclsb-acct__buckets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.pclsb-acct__buckets li { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.pclsb-acct__buckets code { font-size: 9.5px; color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__reset {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; font-size: 10px; padding: 2px 7px; border-radius: 6px;
  cursor: pointer; color: var(--fg-mute, #c2c2c9); background: transparent; border: 1px solid var(--border, rgba(255, 255, 255, 0.16));
}
.pclsb-acct__reset:hover:not(:disabled) { color: var(--fg, #e7e7ea); border-color: var(--fg-mute, #a6a6ad); }
.pclsb-acct__reset:disabled { opacity: 0.55; cursor: default; }
.pclsb-acct__manage { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--accent, #8b5cf6);
  text-decoration: none; align-self: flex-start; }
.pclsb-acct__manage:hover { text-decoration: underline; }
.pclsb-acct__foot { margin: 0; font-size: 10px; line-height: 1.35; color: var(--fg-mute, #8a8a91); border-top: 1px solid var(--border, rgba(255, 255, 255, 0.08)); padding-top: 7px; }
@media (max-width: 300px) {
  .pclsb-acct__top { grid-template-columns: minmax(0, 1fr) auto; }
  .pclsb-acct__btns { grid-column: 1 / -1; }
  .pclsb-acct__usage { grid-template-columns: 1fr; }
  .pclsb-acct__statuspill { justify-self: start; grid-column: 1 / -1; max-width: 100%; }
}
`;
