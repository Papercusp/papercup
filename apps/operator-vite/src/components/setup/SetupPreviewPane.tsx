/**
 * SetupPreviewPane — a read-only preview of the real app shown beside the
 * first-run setup wizard (plan `desktop-workbench-shell-2026-06-05`,
 * P-006 / P-007).
 *
 * Goal: while the user works through setup (the main mode), they see what the
 * real app looks like — the operator workspace (which carries the chat dock)
 * and the pui terminal. Each is a plain iframe so it boots its own providers
 * inside the iframe document, isolated from the chromeless setup page, and
 * self-handles empty/loading states when no harness exists yet (P-007).
 *
 * The previews are `pointer-events: none` (CSS) + `tabIndex={-1}`: illustrative
 * and non-interactive, so nothing destructive can happen before keys /
 * workspace are configured. First-run only — the route composes this; the
 * shared `SetupWizard` (also used in settings mode) is untouched.
 */

import './SetupPreviewPane.css';

export function SetupPreviewPane() {
  return (
    <aside className="pc-setup-preview" aria-label="A preview of your workspace" data-testid="setup-preview">
      <div className="pc-setup-preview__label">A live preview of your workspace</div>
      <div className="pc-setup-preview__frames">
        <div className="pc-setup-preview__frame">
          <span className="pc-setup-preview__cap">Operator + chat</span>
          <iframe
            src="/adv"
            title="Operator workspace preview"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="setup-preview-app"
          />
        </div>
        <div className="pc-setup-preview__frame">
          <span className="pc-setup-preview__cap">Terminal (pui)</span>
          <iframe
            src="/pi"
            title="Terminal preview"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="setup-preview-pui"
          />
        </div>
      </div>
    </aside>
  );
}
