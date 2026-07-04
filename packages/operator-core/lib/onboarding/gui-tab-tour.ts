/**
 * GUI tab-tour registry for the onboarding tutor's finale
 * (plan agent-first-onboarding-2026-07-03, P-018).
 *
 * The finale walks the user through the GUI's main tab strip LEFT TO RIGHT,
 * driving the real window via `ui:dispatch {intent:'set_url'}` while
 * narrating each tab. This module is the server-side source the tutor's
 * launch context renders from ({{GUI_TAB_TOUR}} in onboarding-tutor.md).
 *
 * DRIFT GUARD: the visual truth is `ADV_TABS` in
 * apps/operator-vite/src/components/adv/AdvShell.tsx (array order = strip
 * order; ids are serialized in `?tab=` URLs and are the agent ui:dispatch
 * surface, so they never get renamed). operator-core cannot import that TSX,
 * so gui-tab-tour.test.ts parses the source file and asserts this registry
 * matches it id-for-id, label-for-label, in order — add/remove/reorder a tab
 * in AdvShell.tsx and that test fails until this tour is updated too.
 */

export interface GuiTabTourStop {
  /** `?tab=` id — MUST match an ADV_TABS entry (drift-tested). */
  id: string;
  /** Visible tab label — MUST match ADV_TABS (drift-tested). */
  label: string;
  /** 1–2 sentence narration the tutor gives while showing the tab. */
  blurb: string;
}

/** Strip order = array order (left→right), mirroring ADV_TABS. */
export const GUI_TAB_TOUR: ReadonlyArray<GuiTabTourStop> = [
  {
    id: 'overview',
    label: 'Overview',
    blurb:
      'The landing dashboard — what is running right now, plans that need attention, and the pulse of the whole workspace at a glance.',
  },
  {
    id: 'brainstorm',
    label: 'Brainstorm',
    blurb:
      'A per-project idea canvas: sketch and shape ideas together with agents before they harden into plans.',
  },
  {
    id: 'plans',
    label: 'Create',
    blurb:
      'Where plans live — author them, review their items, and launch them. A plan here is the same durable object agents work from in the terminal.',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    blurb:
      'The time surface for scheduled and recurring plans across every project — anything set to run on a cadence shows up here.',
  },
  {
    id: 'harnesses',
    label: 'Working',
    blurb:
      'The live work view: work items, the agents holding them, and runs in flight for the selected project. This is where you watch progress happen.',
  },
  {
    id: 'health',
    label: 'Health',
    blurb:
      'A read-only system dashboard — Queen, agents, token spend, and infrastructure health in one glance. (May be hidden if its feature flag is off.)',
  },
  {
    id: 'frames',
    label: 'Frames',
    blurb:
      'Live views of deployed agent desktops — the swarm’s actual screens, watchable in real time.',
  },
  {
    id: 'git',
    label: 'Git',
    blurb:
      'The code pipeline: commits flowing from the shared tree, the green gate verdict, and deploys. Agents commit nothing by hand — this shows the automation doing it.',
  },
  {
    id: 'testing',
    label: 'Tests',
    blurb:
      'Test runs and suite health for the project — the evidence behind “done” claims and the gate’s verdicts.',
  },
  {
    id: 'docs',
    label: 'Docs',
    blurb:
      'The project’s documentation tree — the same docs agents read first when asked how something works.',
  },
  {
    id: 'insights',
    label: 'Insights',
    blurb:
      'Usage insights: an activity overview plus token/cost tracking, so you can see what the system spends and where.',
  },
  {
    id: 'conversations',
    label: 'Conversations',
    blurb:
      'Every kind of communication the workspace produces — Q&A, deliberations, agent chats, messages, and the raw coordination log for debugging.',
  },
  {
    id: 'learning',
    label: 'Learning',
    blurb:
      'What the system learns about itself — the improvement backlog agents file into, and learning packs distilled from it (chapter 4 in GUI form).',
  },
  {
    id: 'evals',
    label: 'Evaluation',
    blurb:
      'Impartial third-party benchmark runs — the public evidence for how well the harness performs, kept separate from internal tests.',
  },
  {
    id: 'settings',
    label: 'Settings',
    blurb:
      'Project and workspace settings — including the setup wizard’s knobs, which live on after onboarding for anything you want to adjust later.',
  },
];

/**
 * Render the tour as the markdown block {{GUI_TAB_TOUR}} expands to.
 * Each stop names the tab, the `set_url` target, and the narration seed.
 */
export function guiTabTourMarkdown(): string {
  const stops = GUI_TAB_TOUR.map(
    (t, i) =>
      `${i + 1}. **${t.label}** — \`ui:dispatch {intent:'set_url', args:{path:'/adv', params:{tab:'${t.id}'}}}\` — ${t.blurb}`,
  );
  return [
    ...stops,
    '',
    'Notes: the strip may show fewer tabs than this list — per-project tabs hide when the selector is on “All Pots”, and Health is feature-flag-gated. Skip (don’t mention) any tab the live window doesn’t show; verify with `ui:get_state` if unsure.',
  ].join('\n');
}
