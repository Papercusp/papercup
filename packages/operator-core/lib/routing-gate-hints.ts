/**
 * routing-gate-hints.ts — EI-8809: stamp trigger-matching work-items with the
 * matched "papercusp-way" routing row so a claimer sees the prescribed mechanism
 * IN the dispatched item, not only in the persona prompt they must re-derive it
 * from mid-flow.
 *
 * Root cause (GRADE iteration 1, scorecard EI-8808, rubric su-agent-behavior): a
 * well-executing agent silently bypassed 3 of 4 papercusp-way trigger rows on a
 * provoked battery ("daily 9am digest" → hand-seeded routine instead of
 * plans:set-schedule+arm-schedule; "alert me when gate red" → hand-wired push
 * instead of watch:create; "create a web app" → a page in the existing app
 * instead of templates:*). The routing table lives in the persona; the
 * DISPATCHED ITEM the agent actually reads carries no signal that a row matched.
 *
 * This is a cheap, pure keyword/pattern matcher — HINT ONLY, never a gate: it
 * never blocks a create/claim/dispatch, it only ATTACHES a `routingHint` the
 * claimer's brief can render, e.g. "papercusp way: plans:set-schedule ->
 * plans:arm-schedule (deviating requires stating why)". Mirrors the existing
 * non-blocking-nudge pattern in work_items/create.ts's `codeSmellsLikeCode`.
 *
 * ROUTING_GATE_ROWS covers the 6 rows EI-8809 named explicitly (schedule/
 * recurrence, watch/alert, credential/API key, create-app,
 * bring-repo-under-management, design-screen) — the full su-playbook routing
 * table has more rows; widen ROUTING_GATE_ROWS if a future finding names one.
 */

export interface RoutingGateRow {
  /** Stable id for this row (also usable as a scorecard/rubric join key). */
  id: string;
  /** Human label for the trigger this row matches (kept short for the hint line). */
  trigger: string;
  /** The prescribed papercusp-way mechanism, verbatim enough to act on. */
  mechanism: string;
  /** One-line gloss of why this mechanism, for a claimer unfamiliar with it. */
  gloss: string;
  /** Keywords/phrases (lowercase) — a single hit on title+summary is a match. */
  keywords: readonly string[];
}

export const ROUTING_GATE_ROWS: readonly RoutingGateRow[] = [
  {
    id: 'schedule-recurrence',
    trigger: 'do X daily / weekly / on a schedule',
    mechanism: 'plans:set-schedule THEN plans:arm-schedule',
    gloss: 'arming is a separate, autonomy-gated step — an unarmed schedule never fires.',
    keywords: [
      'daily', 'weekly', 'nightly', 'every day', 'every week', 'on a schedule',
      'on a cadence', 'recurring', 'recurrence', 'cron', 'each morning',
      'every morning', '9am digest', 'periodic', 'every hour', 'hourly',
    ],
  },
  {
    id: 'watch-alert',
    trigger: 'watch for Y / alert me when Z',
    mechanism: 'watch:create',
    gloss:
      'the unified subscription primitive; events:await/topics:subscribe are its presets. Patterns are EXACT-match — fall back to a scheduled poll+diff if events:catalog has no key.',
    keywords: [
      'alert me when', 'alert when', 'notify me when', 'notify when',
      'let me know when', 'watch for', 'keep an eye on', 'ping me when',
      'tell me if', 'tell me when',
    ],
  },
  {
    id: 'credential-key',
    trigger: 'user hands you a credential / API key',
    mechanism: 'setup:save_key',
    gloss:
      'ONLY for the 4 platform provider keys (openai / anthropic / zeroentropy / github_pat) — any other secret goes to injected config outside the repo, never a tree file.',
    keywords: [
      'api key', 'api token', 'access token', 'credential', 'secret key',
      'here is my key', "here's my key", 'save this key', 'oauth token',
    ],
  },
  {
    id: 'create-app',
    trigger: 'create/build an app (any form)',
    mechanism: 'templates:list -> templates:get-guide -> templates:new-app',
    gloss:
      '3 app-scope roots (webapp / desktop / agentic-desktop) — never a hand-rolled scaffold; ask which root when the shape is ambiguous.',
    keywords: [
      'create an app', 'build an app', 'new app', 'scaffold an app',
      'build a web app', 'create a web app', 'build a desktop app',
      'new webapp', 'stand up an app',
    ],
  },
  {
    id: 'bring-repo-under-management',
    trigger: 'bring this repo under management',
    mechanism: 'pot:create_from_repo (GitHub URL) or harness:generate-from-repo (existing local repo)',
    gloss: 'a FORK — pick by whether the repo is a GitHub URL or an already-local checkout.',
    keywords: [
      'bring this repo', 'bring the repo', 'onboard this repo', 'import this repo',
      'manage this repo', 'under management', 'add this repo to papercusp',
    ],
  },
  {
    id: 'design-screen',
    trigger: 'design this screen / component',
    mechanism: 'design-phase.search_registry -> spec -> design-phase.validate_spec / lint_spec',
    gloss: 'search the existing component registry FIRST instead of inventing a new component.',
    keywords: [
      'design this screen', 'design a screen', 'design this component',
      'design a component', 'new ui screen', 'design the ui for',
    ],
  },
] as const;

export interface RoutingGateHint {
  row: string;
  mechanism: string;
  gloss: string;
  /** The keyword that triggered the match — useful for a claimer to sanity-check the hit. */
  matchedOn: string;
}

/**
 * Cheap keyword match of `title` + `summary` against ROUTING_GATE_ROWS. Returns
 * the FIRST matching row (rows are checked in declaration order) or `null` when
 * nothing matches. Pure, synchronous, case-insensitive substring match — no I/O,
 * safe to call on every create/claim/dispatch.
 */
export function matchRoutingGateHint(
  title: string | null | undefined,
  summary?: string | null,
): RoutingGateHint | null {
  const hay = `${title ?? ''} ${summary ?? ''}`.toLowerCase();
  if (!hay.trim()) return null;
  for (const row of ROUTING_GATE_ROWS) {
    const hit = row.keywords.find((kw) => hay.includes(kw));
    if (hit) {
      return { row: row.id, mechanism: row.mechanism, gloss: row.gloss, matchedOn: hit };
    }
  }
  return null;
}

/** Render a RoutingGateHint as the one-line brief a claimer sees. */
export function renderRoutingGateHintLine(hint: RoutingGateHint): string {
  return `papercusp way: ${hint.mechanism} (${hint.gloss})`;
}
