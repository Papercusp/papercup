/**
 * The Events file — the single inspectable list of first-party reaction rules
 * (event-reaction-system D-002). All built-in "when X, fire Y" wiring lives
 * HERE, in one place, not scattered across handlers. Importing this module
 * registers them.
 *
 * (Two other authoring forms feed the SAME registry: `emits:` co-location sugar
 * on a tool — coord-lifecycle-automation D-002 — and plugin/blueprint rules —
 * D-012. This file is for contextual cross-tool reactions that don't belong to
 * any single tool's contract.)
 */

import { registerReactionRule } from './registry';
import { formatHandoff, type HandoffArgs } from './format-handoff';

/**
 * D-008 — the motivating rule: defer → render on the agent's pane.
 *
 * When an agent defers work by opening a `coord:handoff`, auto-render the
 * deferral on that agent's own pane via the activity bridge — so the agent
 * spends ZERO tokens listing its deferrals; the system reacts.
 *
 * (The plan's illustrative pseudo-code fired `ui:dispatch` with `pane:ctx.agent`
 * + `formatHandoff`. Those don't exist as written — `ui:dispatch` targets
 * browser tabs, there is no `ctx.agent`, and `coord:handoff` has no `item`
 * field. The real "render on the agent's pane, zero tokens" mechanism is
 * `activity:report` keyed by `ctx.uiClientId`, which the pui fleet view
 * SSE-renders in that agent's activity lane. Same intent, working tools.)
 */
registerReactionRule({
  id: 'defer-renders-on-pane',
  on: 'coord:handoff',
  // Fire on OPEN handoffs only (they carry a summary), not accepts
  // (accept_msg_id), and only when we know whose pane to render on.
  when: (e) => {
    const a = e.args as { summary?: string; accept_msg_id?: string } | undefined;
    return Boolean(a?.summary) && !a?.accept_msg_id && Boolean(e.ctx.uiClientId);
  },
  fire: 'activity:report',
  args: (e) => {
    const a = e.args as HandoffArgs;
    return {
      owner: e.ctx.uiClientId,
      kind: 'lifecycle',
      summary: formatHandoff(a),
      session_id: e.ctx.spawnId ?? undefined,
      harness_slug: e.ctx.harnessSlug ?? undefined,
    };
  },
  onlyOnSuccess: true,
  source: 'events-file',
});
