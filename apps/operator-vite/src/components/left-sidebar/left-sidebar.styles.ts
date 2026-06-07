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
  position: fixed;
  top: 0;
  left: var(--op-chat-w, 0px); /* dock AFTER the op-chat sidebar */
  bottom: 0;
  z-index: 1290; /* just under the op-chat sidebar / dev rail layer */
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-1, #0a1422), transparent 2%),
    color-mix(in srgb, var(--bg-deep, #060d18), transparent 0%)
  );
  border-right: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 78%);
  box-shadow: 18px 0 48px rgba(0, 0, 0, 0.32);
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
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 76%);
  background:
    radial-gradient(circle at 35% 25%, rgba(255, 255, 255, 0.16), transparent 24%),
    color-mix(in srgb, var(--accent, #57d7ff), transparent 88%);
  color: var(--accent-strong, #7dd3fc);
  cursor: pointer;
}
.pclsb__rail-btn:hover {
  border-color: rgba(103, 232, 249, 0.5);
  color: #eff8ff;
}
.pclsb__rail-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 18%);
  outline-offset: -3px;
}

/* Header */
.pclsb__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 84%);
  background: color-mix(in srgb, var(--bg-deep, #060d18), transparent 6%);
}
.pclsb__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 760;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(203, 238, 255, 0.82);
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
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 84%);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(214, 236, 248, 0.78);
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb__iconbtn:hover {
  background: rgba(12, 24, 38, 0.96);
  border-color: rgba(103, 232, 249, 0.4);
  color: #eff8ff;
}

/* Tab strip — the Swarm / Voice / Hives switcher (mirrors the pui main pane). */
.pclsb__tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 88%);
}
.pclsb__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: rgba(214, 236, 248, 0.66);
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: color 120ms, border-color 120ms;
}
.pclsb__tab:hover {
  color: #eff8ff;
}
.pclsb__tab.is-active {
  color: #f7fdff;
  border-bottom-color: var(--accent, #57d7ff);
}
.pclsb__tab-icon {
  display: inline-flex;
  color: var(--accent, #57d7ff);
  opacity: 0.85;
}

/* Active panel body */
.pclsb__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 0 10px;
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
  gap: 8px;
  padding: 8px 12px 14px;
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
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 0.78);
}
.pclsb-panel__bar-spacer {
  flex: 1;
}
.pclsb-panel__empty {
  padding: 14px 4px;
  color: rgba(148, 163, 184, 0.74);
  font-size: 12px;
  text-align: center;
  line-height: 1.6;
}
.pclsb-panel__error {
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(248, 113, 113, 0.32);
  background: rgba(248, 113, 113, 0.08);
  color: #fda4af;
  font-size: 12px;
  line-height: 1.5;
}
.pclsb-chipbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 82%);
  background: rgba(255, 255, 255, 0.03);
  color: rgba(214, 236, 248, 0.8);
  font-size: 11px;
  cursor: pointer;
  transition: background 120ms, border-color 120ms, color 120ms;
}
.pclsb-chipbtn:hover {
  border-color: rgba(103, 232, 249, 0.4);
  color: #eff8ff;
}
.pclsb-chipbtn.is-on {
  background: rgba(56, 189, 248, 0.16);
  border-color: rgba(103, 232, 249, 0.45);
  color: #bfeaff;
}

/* Rows (agents / hives / tasks / mail) */
.pclsb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 88%);
  background: color-mix(in srgb, var(--bg-deep, #060d18), transparent 12%);
  cursor: default;
}
.pclsb-row + .pclsb-row {
  margin-top: 5px;
}
.pclsb-row.is-clickable {
  cursor: pointer;
}
.pclsb-row.is-clickable:hover {
  border-color: rgba(103, 232, 249, 0.34);
}
.pclsb-row.is-selected {
  border-color: var(--accent, #57d7ff);
  background: color-mix(in srgb, var(--bg-raised, #0e1c30), transparent 2%);
}
.pclsb-row__main {
  flex: 1;
  min-width: 0;
}
.pclsb-row__title {
  font-size: 13px;
  font-weight: 600;
  color: #eff8ff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-row__sub {
  margin-top: 2px;
  font-size: 11px;
  color: rgba(205, 226, 240, 0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pclsb-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(148, 163, 184, 0.6);
}
.pclsb-dot.is-up {
  background: #4ade80;
  box-shadow: 0 0 7px rgba(74, 222, 128, 0.7);
}
.pclsb-dot.is-down {
  background: #f87171;
}
.pclsb-pill {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: rgba(148, 163, 184, 0.18);
  color: rgba(214, 236, 248, 0.82);
}

/* Section headers inside a tab (task list / plan progress / comms). */
.pclsb-sec {
  margin-top: 10px;
}
.pclsb-sec__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: rgba(148, 163, 184, 0.78);
  padding: 2px 1px 6px;
}
.pclsb-task {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 3px 2px;
  font-size: 12px;
  color: rgba(222, 240, 250, 0.88);
}
.pclsb-task__rank {
  flex: 0 0 34px;
  color: rgba(148, 163, 184, 0.75);
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
  color: rgba(148, 163, 184, 0.8);
}

/* Plan progress bars */
.pclsb-plan {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 12px;
}
.pclsb-plan__slug {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(222, 240, 250, 0.88);
}
.pclsb-plan__bar {
  flex: 0 0 90px;
  height: 6px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  overflow: hidden;
}
.pclsb-plan__fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent, #57d7ff);
}
.pclsb-plan__nums {
  flex: 0 0 auto;
  font-size: 10px;
  color: rgba(148, 163, 184, 0.85);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* Mail / conversation lines (comms view) */
.pclsb-mail {
  padding: 4px 2px;
  font-size: 12px;
  color: rgba(222, 240, 250, 0.85);
  border-bottom: 1px dashed color-mix(in srgb, var(--accent-strong, #38bdf8), transparent 90%);
}
.pclsb-mail__meta {
  font-size: 10px;
  color: rgba(148, 163, 184, 0.75);
}

/* The Voice tab's video region wants the full panel height. */
.pclsb-voice {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.pclsb-voice__grid {
  flex: 1;
  min-height: 240px;
}
`;
