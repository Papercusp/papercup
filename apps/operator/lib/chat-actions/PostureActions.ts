/**
 * Posture modes — the autonomy axis (manual/auto/cold-auto) and the three
 * stackable overlays (ideate/drain/grade) as FOUR ChatModeActions writing
 * mode:set { ownerDirected: true }
 * (gui-chat-session-controls-2026-07-25 P-004, reshaped by
 * session-chat-popup-direction-d-2026-08-02 P-005).
 *
 * P-005 changed the SHAPE, not the writes. These were two ChatActions —
 * buttons labelled `Autonomy` and `Overlays` that opened a card and reported
 * nothing about the current state, so the state had to appear elsewhere as a
 * read-only chip. One concept, two objects, two places, neither admitting it
 * was the other: that is the confusion the owner reported. As mode-actions
 * they report AND set, so each is one pill.
 *
 * Labels/hints come from the mode registry
 * (packages/operator-core/lib/modes/registry — the SAME source mode:set /
 * mode:get / the HUD chips already read) so no new copy drifts from it.
 *
 * Both actions post through the admin proxy route
 * (packages/operator-core/lib/endpoint-route/routes/admin/mode.ts, P-003) —
 * the browser has no bearer token, so the route re-dispatches into mode:set
 * in-process with a verified owner-authority identity
 * (ident.ownerId === ADMIN_COORD_UI_OWNER), which is what lets this write
 * carry ownerDirected:true and arm the D-003 sticky guard.
 *
 * No live "what's currently set" read: both `run` implementations are
 * reconciling (they set every option's enabled state explicitly — the
 * unchecked/unselected ones included), so posting is safe and idempotent
 * regardless of prior state, and mode:set { enabled:false } is a no-op on
 * whichever mode wasn't already active. This avoids needing a mode:get round
 * trip just to pre-populate the card.
 */
import { fetchSyncQuery } from '@papercusp/sync';
import { modeById, modeChipLabel } from '@papercusp/operator-core/lib/modes/registry';
import { registerChatModeAction } from './registry';
import type { ChatActionContext } from './types';

const AUTONOMY_IDS = ['manual', 'auto', 'cold-auto'] as const;
type AutonomyId = (typeof AUTONOMY_IDS)[number];

/**
 * The overlays whose value really is just on/off.
 *
 * `grade` USED to be in this list and is registered separately below (WI-7471):
 * turning grading on means naming a rubric, so its menu is `Off` + one row per
 * active rubric rather than `On`/`Off`. Leaving it here as well would register
 * the axis TWICE under the same id — so removing it from this array is part of
 * that change, not an unrelated tidy-up.
 */
const OVERLAY_IDS = ['ideate', 'drain'] as const;
type OverlayId = (typeof OVERLAY_IDS)[number];

/** POST one mode:set write through the admin proxy route (P-003). Exported for tests. */
/**
 * Send the session's agent a request, the same way the composer under this bar
 * does — `coord:send` with `wake: 'required'`.
 *
 * Deliberately the SAME endpoint and the same wake level as
 * `sendToSessionOwner` in SessionChatModal rather than a second path: a menu row
 * that says "ask this agent" must reach the agent by the mechanism the reader
 * can see working three inches below it, or the two silently diverge and only
 * one of them wakes anybody.
 *
 * Exported for tests.
 */
export async function askAgent(agent: string, body: string): Promise<void> {
  const r = await fetch('/api/admin/coord/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      to: [agent],
      summary: body.length > 80 ? `${body.slice(0, 77)}…` : body,
      body,
      wake: 'required',
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`coord:send → ${r.status}: ${text.slice(0, 200)}`);
  }
}

export async function postModeSet(agent: string, mode: string, enabled: boolean, reason: string): Promise<void> {
  const r = await fetch('/api/admin/mode/set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, enabled, reason, agent, ownerDirected: true }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`mode:set(${mode}) → ${r.status}: ${text.slice(0, 200)}`);
  let parsed: { ok?: boolean; error?: string; stickyConflict?: boolean } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* tolerate a non-JSON 200 — treated as success */
  }
  if (parsed.ok === false) {
    throw new Error(
      parsed.stickyConflict
        ? `mode:set(${mode}) refused — an owner-directed incumbent is already set; your change was delivered as a request instead`
        : `mode:set(${mode}) → ${parsed.error ?? 'unknown error'}`,
    );
  }
}

function ownerId(ctx: ChatActionContext): string {
  return ctx.sessionOwnerId;
}

/**
 * The standing modes currently registered on the session this chat is attached
 * to, read straight off `ctx`.
 *
 * The roster row types `modes` as `Array<HudMode | string>` — a bare string is
 * tolerated because federation and a mid-deploy SSE push both produce one — so
 * both shapes are normalised here. Exported for test.
 */
export function activeModes(ctx: ChatActionContext): Set<string> {
  const raw = ctx.modes;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const m of raw) {
    if (typeof m === 'string') {
      out.add(m);
    } else if (m && typeof m === 'object' && typeof (m as { mode?: unknown }).mode === 'string') {
      out.add((m as { mode: string }).mode);
    }
  }
  return out;
}

/* ── P-005: the four Mode pills ────────────────────────────────────────────
 * These REPLACE the previous `Autonomy` and `Overlays` buttons. Those were
 * verbs that opened a card, and said nothing about what was currently set —
 * so the current value had to be shown elsewhere as a read-only chip, which is
 * the AUTO-chip/Autonomy-button duplicate the owner reported. A pill reports
 * and sets, so each mode is now exactly one object on the surface.
 * ────────────────────────────────────────────────────────────────────────── */

registerChatModeAction({
  id: 'mode-autonomy',
  cap: 'AUTO',
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  current: (ctx) => {
    const modes = activeModes(ctx);
    // Order matters: cold-auto is the more specific of the two, and an agent
    // carrying both should read as the colder one rather than silently
    // reporting the warmer.
    if (modes.has('cold-auto')) {
      return { value: 'cold', optionId: 'cold-auto', on: true, title: modeById('cold-auto')?.oneLiner };
    }
    if (modes.has('auto')) {
      return { value: 'on', optionId: 'auto', on: true, title: modeById('auto')?.oneLiner };
    }
    return {
      value: 'off',
      optionId: 'manual',
      on: false,
      title: 'Confirm-before-acting posture — no standing autonomy mode is set',
    };
  },
  options: () =>
    AUTONOMY_IDS.map((id) => ({
      id,
      label: id === 'manual' ? 'Manual' : (modeById(id)?.title ?? modeChipLabel(id)),
      hint:
        id === 'manual'
          ? 'Confirm-before-acting posture — no standing autonomy mode'
          : modeById(id)?.oneLiner,
    })),
  set: async (ctx, optionId) => {
    const choice = optionId as AutonomyId;
    const reason = 'owner set autonomy posture from the chat control band';
    const agent = ownerId(ctx);
    // RECONCILE THE WHOLE AXIS, always. The previous implementation only
    // ENABLED the chosen mode, so switching auto → cold-auto left `auto`
    // standing as well and the agent carried two autonomy modes at once.
    // enabled:false is a no-op on whichever was not set, so setting every
    // option explicitly is both correct and safe with no prior-state read.
    await Promise.all(
      AUTONOMY_IDS.filter((id) => id !== 'manual').map((id) =>
        postModeSet(agent, id, id === choice, reason),
      ),
    );
  },
});

/**
 * The shape of one `rubrics.list` sync-query row.
 *
 * VERIFIED against the producer, not inherited (WI-7471): rubrics moved from a
 * standalone `harness_shared.rubrics` table to plans (`template:'rubric'`,
 * migration 353), so a field list copied from the pre-migration code could have
 * been quietly wrong. These four are what `rubrics.list`'s derived-read producer
 * actually projects today — packages/operator-core/lib/derived-reads/producers.ts.
 * Only the fields this module reads are declared.
 */
interface RubricListRow {
  rubricId: string;
  characteristic: string;
  title: string;
  status: 'proposed' | 'active' | 'retired';
}

/** The `off` row of the GRADE menu. Its id can never collide with a rubric id
 *  by accident, because rubric ids are slugs and this is compared first. */
const GRADE_OFF = 'off';

/* ── the two non-rubric rows [owner 2026-08-03] ──────────────────────────────
 * "grade mode rubric selector should have a create rubric option if there are
 * no rubrics. If there are a lot rubrics too much to show that should be
 * handled gracefully."
 *
 * Both ends of the same problem: the menu was only correct for the middle of
 * the range. With zero active rubrics it rendered `Off` alone — a menu whose
 * only option is "no", telling the reader nothing about how to get a rubric.
 * With forty it would have rendered forty rows inside a popup that is already
 * height-constrained.
 *
 * Both rows resolve to ASKING THIS AGENT, and that is not a cop-out — it is the
 * only create path that exists. Rubrics are authored by agents through the
 * `rubrics:*` tools; there is no owner-facing rubric form anywhere in the app,
 * and the `/rubrics` route was REMOVED from the navbar in 2026-07 precisely
 * because the live Vite operator never registered it (ChromeShell.tsx:311).
 * Linking a "create" affordance at a route that 404s would be worse than the
 * dead end it replaces. The composer three inches below this menu wakes the
 * agent, so these rows do exactly what a reader would otherwise type by hand.
 *
 * Ids are `__`-prefixed so they can never collide with a rubric slug. */
const GRADE_CREATE = '__create-rubric';
const GRADE_MORE = '__more-rubrics';

/**
 * How many rubrics the menu shows before it stops listing and starts counting.
 *
 * 8 because the menu opens INSIDE the session popup and flips up when there is
 * no room below (measured: the mode pills sit ~26px above the popup's lower
 * edge, so the menu always opens upward into the transcript). A row is ~30px,
 * so 8 rubrics plus `Off` plus the overflow row is ~300px — about a third of an
 * 800px viewport, which still leaves the conversation readable behind it.
 */
const RUBRIC_MENU_CAP = 8;

/**
 * GRADE — the one overlay whose "on" carries a VALUE, so it does not fit the
 * plain on/off shape the other two share (WI-7471).
 *
 * [owner 2026-08-03] "I want the rubric picker back, add that to the grade
 * on/off toggle." The rubric picker used to be a separate `Grade session…`
 * button; WI-7439 removed it as a duplicate of this pill's on/off toggle, which
 * was right about the duplication and did lose the rubric CHOICE with it. It
 * comes back HERE rather than as a second button, which is what the owner asked
 * for and is also the better shape: a mode and the control that sets it are ONE
 * object (see types.ts), and "which rubric" is simply that mode's value.
 *
 * `options()` is async — the rubric set is fetched, lazily, when the menu opens.
 * `params()`-style fetching is the same pattern the deleted GradeAction used;
 * see types.ts's `options` doc for why this is async while `current()` is not.
 */
registerChatModeAction({
  id: 'mode-grade',
  cap: modeChipLabel('grade').toUpperCase(),
  group: 'posture',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  // PURE + sync, like every other axis: read straight off the roster row. The
  // pill reports WHETHER grading is on; the chosen rubric rides in the mode's
  // free-text reason (the same place the old GradeAction put it), which is not
  // part of the roster projection — so claiming to display it here would mean
  // displaying something this function cannot actually know.
  current: (ctx) => {
    const on = activeModes(ctx).has('grade');
    return { value: on ? 'on' : 'off', optionId: on ? undefined : GRADE_OFF, on, title: modeById('grade')?.oneLiner };
  },
  options: async () => {
    const rows = await fetchSyncQuery<RubricListRow>({ queryName: 'rubrics.list', args: {} });
    // ACTIVE only: a proposed rubric is not yet something to grade against, and
    // a retired one is deliberately out of use.
    const active = rows.filter((r) => r.status === 'active');
    /* Stable order before the cap, or "the first 8" means "whatever the
       resolver happened to return" and the SAME workspace shows a different 8
       between two opens. */
    active.sort((a, b) => a.title.localeCompare(b.title));
    const shown = active.slice(0, RUBRIC_MENU_CAP);
    const hidden = active.length - shown.length;
    return [
      {
        id: GRADE_OFF,
        label: 'Off',
        // WI-6552 [owner 2026-07-27]: the picker EXPLAINS what grade mode is
        // rather than just naming the input. The owner met the old rubric list
        // with no idea what it would do — "something that comes up that
        // explains what grade mode is" — and a workspace can hold a dozen
        // active rubrics, so the bare list gave no clue what picking one
        // commits the agent to. The explanation survives the move onto the
        // pill; it just rides the menu's first row now instead of a card.
        hint: 'Grade mode asks this agent to score its own work against a rubric — a named checklist of criteria — and report the result, instead of just carrying on. Pick a rubric to turn it on.',
      },
      ...shown.map((r) => ({ id: r.rubricId, label: r.title, hint: r.characteristic })),
      /* NOTHING to grade against. `Off` alone is a menu whose only option is
         "no" — it does not even tell the reader that rubrics are a thing the
         agent can make. */
      ...(active.length === 0
        ? [
            {
              id: GRADE_CREATE,
              label: 'Ask this agent to create one',
              hint: 'No rubrics exist yet. Rubrics are written by agents, so this sends this agent a request to draft one for the work it is doing and propose it for ratification.',
            },
          ]
        : []),
      /* TOO MANY to list. The count is the point: "8 of 23" is a different
         situation from "8", and a menu that silently truncates teaches the
         reader that the 8 are all there are. */
      ...(hidden > 0
        ? [
            {
              id: GRADE_MORE,
              label: `${hidden} more — ask this agent to choose`,
              hint: `Showing ${shown.length} of ${active.length} active rubrics. Rather than scroll a list this long inside the popup, this asks the agent to pick the one that best fits its current work and turn grade mode on with it.`,
            },
          ]
        : []),
    ];
  },
  set: async (ctx, optionId) => {
    const agent = ownerId(ctx);
    if (optionId === GRADE_OFF) {
      await postModeSet(agent, 'grade', false, 'owner turned grade mode off from the chat control band');
      return;
    }
    /* These two rows do NOT touch grade mode — they ask the agent to do
       something, exactly as typing it into the composer below would. Kept
       distinct from the mode path on purpose: turning grade mode ON without a
       rubric is the WI-7471 defect (a mode set with no criteria, the rubric
       surviving only as free text in the reason), and it would be a regression
       to re-introduce it here under a friendlier label. */
    if (optionId === GRADE_CREATE) {
      await askAgent(
        agent,
        'Please create a rubric. There are no active rubrics in this workspace, so grade mode has nothing to score against. Draft one for the work you are doing now — name the characteristic it measures and its criteria — propose it for ratification, and tell me its id when it is in.',
      );
      return;
    }
    if (optionId === GRADE_MORE) {
      await askAgent(
        agent,
        'Please turn grade mode on and pick the rubric yourself. There are more active rubrics than the chat menu lists, so rather than have me scroll them: choose the one that best fits the work you are doing now, say which you picked and why, and set grade mode to it.',
      );
      return;
    }
    await postModeSet(
      agent,
      'grade',
      true,
      `owner selected rubric ${optionId} for grade mode from the chat control band`,
    );
  },
});

for (const overlay of OVERLAY_IDS) {
  registerChatModeAction({
    id: `mode-${overlay}`,
    cap: modeChipLabel(overlay).toUpperCase(),
    group: 'posture',
    available: (ctx) => Boolean(ctx.sessionOwnerId),
    current: (ctx) => {
      const on = activeModes(ctx).has(overlay);
      return { value: on ? 'on' : 'off', on, title: modeById(overlay)?.oneLiner };
    },
    // Stackable overlays are independent booleans, so each pill offers only
    // its own two states — which is also why they are separate pills rather
    // than one multi-select: three independent switches read as three
    // switches, and the old single `Overlays` button hid all three behind a
    // name that named none of them.
    options: () => [
      { id: 'on', label: 'On', hint: modeById(overlay)?.oneLiner },
      { id: 'off', label: 'Off' },
    ],
    set: async (ctx, optionId) => {
      await postModeSet(
        ownerId(ctx),
        overlay,
        optionId === 'on',
        'owner set overlay modes from the chat control band',
      );
    },
  });
}
