/**
 * The "+ Start a goal" composer's non-visual half (goals-tab-improvement-2026-08-09 P-015).
 *
 * Validation and the POST live here, apart from the JSX, because both are
 * behaviour worth pinning and neither needs a DOM: the required-field rule is
 * the ONLY place GOAL mode's "kill criterion and ceiling at creation" contract
 * can now be enforced (the conversational kickoff that used to carry it was
 * deleted with the rail), and the response parse is a two-layer envelope that
 * has already been hand-rolled once per caller.
 */

/** What the form collects, before it becomes tool args. */
export interface GoalComposerDraft {
  /** The outcome, stated so its achievement is checkable. */
  title: string;
  /** The written condition under which the goal is abandoned. */
  killCriterion: string;
  /** The spend ceiling AS TYPED, in dollars — "500", "500.00", "$500". */
  ceiling: string;
  /** Optional longer statement: what winning looks like, scope, constraints. */
  body?: string;
}

export interface GoalStartArgs {
  title: string;
  killCriterion: string;
  budgetCents: number;
  body?: string;
}

export type GoalDraftValidation =
  | { ok: true; args: GoalStartArgs }
  | { ok: false; errors: Partial<Record<keyof GoalComposerDraft, string>> };

/**
 * Dollars-as-typed → integer cents.
 *
 * Returns null for anything that is not a non-negative amount. Rounds rather
 * than truncates so "0.005" cannot silently become 0 — a ceiling that reads
 * back lower than what was typed is the one rounding direction the owner would
 * be entitled to be annoyed about.
 */
export function ceilingToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * The required-field rule, stated once.
 *
 * Kill criterion and ceiling are NOT optional here even though
 * `harness_shared.goals` allows both to be null — `goals:create` has to permit
 * a bare row (an agent recording a goal it was handed), but a goal STARTED
 * from this form spawns an autonomous agent, and an autonomous agent with no
 * written stopping condition and no declared ceiling is the thing GOAL mode's
 * contract exists to prevent. `goals:start` rejects the call too; this makes
 * the refusal legible in the form instead of arriving as a server error.
 */
export function validateGoalDraft(draft: GoalComposerDraft): GoalDraftValidation {
  const errors: Partial<Record<keyof GoalComposerDraft, string>> = {};
  const title = draft.title.trim();
  const killCriterion = draft.killCriterion.trim();
  const cents = ceilingToCents(draft.ceiling);

  if (!title) errors.title = 'State the outcome — what does winning look like?';
  if (!killCriterion) errors.killCriterion = 'Required: the condition under which you abandon this.';
  if (cents === null) {
    errors.ceiling = draft.ceiling.trim()
      ? 'Enter an amount in dollars, e.g. 500 or 500.00.'
      : 'Required: the spend ceiling actuals are reported against.';
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    args: {
      title,
      killCriterion,
      budgetCents: cents as number,
      ...(draft.body?.trim() ? { body: draft.body.trim() } : {}),
    },
  };
}

export type GoalStartResult =
  | { ok: true; goalId: string; agentOwnerId: string | null }
  | { ok: false; error: string };

/**
 * POST the composer to `goals:start`.
 *
 * The projected-tool transport wraps a tool's `data` in an MCP content
 * envelope, so the payload sits one JSON parse deeper than it looks — the same
 * double-parse `postGoalCreate` does in GoalProposalCard.tsx. An `isError`
 * result carries its message as PROSE in that same content slot rather than as
 * `error`, which is why the failure path reads `content[0].text` too: treating
 * a rolled-back launch as an unparseable response would tell the owner nothing
 * about what went wrong.
 */
export async function postGoalStart(
  args: GoalStartArgs,
  opts: {
    workspaceId: string;
    harnessSlug: string;
    fetchImpl?: typeof fetch;
  },
): Promise<GoalStartResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const qs = new URLSearchParams({ ws: opts.workspaceId, harness: opts.harnessSlug });
  let text: string;
  let httpOk: boolean;
  let status: number;
  try {
    const r = await doFetch(`/api/agent-tools/goals/start?${qs.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': opts.workspaceId },
      body: JSON.stringify({ ...args, harness: opts.harnessSlug }),
    });
    httpOk = r.ok;
    status = r.status;
    text = await r.text();
  } catch (e) {
    return { ok: false, error: `goals:start — could not reach the operator: ${(e as Error)?.message ?? e}` };
  }
  if (!httpOk) return { ok: false, error: `goals:start → ${status}: ${text.slice(0, 200)}` };

  try {
    const outer = JSON.parse(text) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
      error?: string | { message?: string };
    };
    const inner = outer.content?.[0]?.text;
    if (outer.error) {
      const msg = typeof outer.error === 'string' ? outer.error : (outer.error.message ?? 'start failed');
      return { ok: false, error: msg };
    }
    // A refusal (bad input, or a spawn that failed and rolled back) comes back
    // as isError + prose. Surface the prose: it names the rollback.
    if (outer.isError) return { ok: false, error: inner?.slice(0, 400) ?? 'goals:start refused the call' };
    if (!inner) return { ok: false, error: 'goals:start returned no content' };

    const data = JSON.parse(inner) as {
      id?: string;
      agent_owner_id?: string;
      degradedReasons?: string[];
    };
    if (!data.id) {
      return { ok: false, error: data.degradedReasons?.join('; ') ?? 'goals:start returned no goal id' };
    }
    return { ok: true, goalId: data.id, agentOwnerId: data.agent_owner_id ?? null };
  } catch {
    return { ok: false, error: `goals:start — unparseable response: ${text.slice(0, 200)}` };
  }
}
