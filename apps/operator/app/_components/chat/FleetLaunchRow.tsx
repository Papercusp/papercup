'use client';

/**
 * FleetLaunchRow — the agent chat popup's ALWAYS-VISIBLE fleet-launch row
 * (WI-6505, owner ask 2026-07-27).
 *
 * The owner asked for this twice, and the second message revised the first:
 *   (i)  "Add a new fleet button to the agent chant popup on the bottom next to
 *        where you can select grade, that presents the user with all the options
 *        for fleet launching that agents are supposed to ask a user about. i.e.
 *        which account. which model, headed or headed, how many, default system
 *        account or pin to an account using the inference gateway."
 *   (ii) "Instead of abutton like the others make this fleet launching its own
 *        always visible row modeled after how the new session row works on the
 *        main hud page"
 *
 * (ii) governs the FORM — one always-visible row, NOT a button in ChatActionBar
 * alongside Grade. (i) still governs the CONTENT: every option an agent is
 * supposed to ask about before launching a fleet is exposed here, so the human
 * answers them once in the UI instead of over five chat turns.
 *
 * ── Why this is a sibling of ChatActionBar, not an entry in it ───────────────
 * ChatActionBar renders the ChatAction registry, and every one of those actions
 * targets THIS session (grade it, resume it, change its posture). A fleet launch
 * is not an act on the open session — it creates N new ones. It is also gated
 * differently: the action bar only mounts when `actionCtx` resolves (a live
 * session with a known owner id), and the owner asked for this row to be ALWAYS
 * visible. Registering it as a ChatAction would have inherited that gate and hid
 * the row exactly when a human most wants it (the session is dead/stuck — launch
 * a fleet instead).
 *
 * ── The launch path is the REAL one ─────────────────────────────────────────
 * POST /api/agent-tools/fleet/launch-on-plan — the same `fleet:launch-on-plan`
 * tool an agent calls, reached over the auto-mounted agent-tools HTTP route. It
 * is the only path that carries all five of the owner's options (`account`,
 * `model`, `headless`, `count`, and the gateway pin that rides `account`).
 *
 * Deliberately NOT `launchAgent`/launch-su, which the HUD's new-session row uses:
 * that launches exactly ONE session and has no `headless` and no `count`, so a
 * "fleet" built on it would be a form that looks right and cannot do the job.
 * Modelling the row on the new-session row (the owner's ask) is about its SHAPE
 * and its primitives, not about reusing its endpoint.
 *
 * ── Option sources are SHARED, never re-declared ────────────────────────────
 * Models/efforts/accounts come from the same exports the HUD's new-session row
 * uses (`OMP_MODEL_OPTIONS`, `buildAccountOptions`, `useSuLaunchOptions` → psu's
 * own options endpoint). This repo has twice paid for a hand-maintained rival
 * list drifting from psu's (WI-6300 — the model menu had fallen four models
 * behind; WI-6321 — fleet/account/context were unreachable from the GUI at all).
 * Derive; never re-declare.
 *
 * ── State is nuqs ───────────────────────────────────────────────────────────
 * Per CLAUDE.md: user-meaningful selections go in the URL, and the agent → UI
 * control surface (`ui:get_state` / `ui:dispatch`) reads and writes the URL, so
 * `useState` here would make the row invisible to the very agents that are
 * supposed to stop asking these questions in chat. That is the load-bearing
 * reason, and it is why this row diverges from NewSessionLauncher's documented
 * `useState` choice: that launcher's picks are a private mid-edit draft, while
 * these are a shareable, agent-driveable launch configuration.
 */
import { useCallback, useMemo, useState } from 'react';
import { parseAsBoolean, parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@/app/harness/Button';
import { Combobox, type ComboboxOption } from '@/app/harness/Combobox';
import { FLEET_MAX_MEMBERS } from '@papercusp/operator-core/lib/agent-config-constants';
import { usePlanList } from '@/app/admin/plans/plans-api';
import {
  ACCOUNT_SELECT_DEFAULT,
  MODEL_SELECT_DEFAULT,
  OMP_MODEL_OPTIONS,
  PLAN_SELECT_PLACEHOLDER,
  buildAccountOptions,
  buildLaunchPlanOptions,
  modelBackend,
} from '@/app/adv/sessions/NewSessionLauncher';
import { useSuLaunchOptions } from '@/app/adv/sessions/use-su-launch-options';

/** The agent-tools HTTP mount for `fleet:launch-on-plan` (`<group>/<verb>`). */
export const FLEET_LAUNCH_ROUTE = '/api/agent-tools/fleet/launch-on-plan';

/**
 * Headed vs headless — the owner's "headed or headed", which is an obvious typo
 * for headed/headless (there is no second "headed" mode to pick between).
 *
 * Both values are explicit rows rather than a checkbox: this is the one option
 * whose wrong answer is expensive and invisible (headless members have no window
 * to notice), so it reads as a deliberate pick, not a toggle you skim past.
 */
export const HEADED_VALUE = 'headed';
export const HEADLESS_VALUE = 'headless';

export const WINDOW_MODE_OPTIONS: ComboboxOption[] = [
  {
    value: HEADED_VALUE,
    label: 'Headed',
    detail: 'Visible desktop terminal per member',
  },
  {
    value: HEADLESS_VALUE,
    label: 'Headless',
    detail: 'Background sessions, no window — logs to a file',
  },
];

/**
 * Clamp a member count to the range the tool actually accepts.
 *
 * The ceiling is imported from the client-safe constants module, which
 * `fleet:launch-on-plan` itself imports for its own `.max()` — so this control
 * cannot offer a count the tool would reject (WI-6505 lifted the constant there
 * for exactly this reason).
 *
 * Pure — exported for unit-test access.
 */
export function clampMemberCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(FLEET_MAX_MEMBERS, Math.max(1, Math.trunc(n)));
}

/**
 * Turn the agent-tools envelope into a human sentence.
 *
 * Every agent-tools route answers `{ content: [{ type:'text', text }] }`, with
 * `isError` on refusals; `fleet:launch-on-plan` puts a JSON document in `text`.
 * A launch can also come back `ok:false` with a populated `failed[]` — members
 * that did not open — which is NOT an HTTP failure, so a caller keying only on
 * `r.ok` would report a launch that opened nothing as a success. Read the
 * payload, not the status.
 *
 * Pure — exported for unit-test access.
 */
export function describeLaunchResult(body: unknown): { ok: boolean; message: string } {
  const envelope = body as { content?: Array<{ text?: string }>; isError?: boolean } | null;
  const text = envelope?.content?.[0]?.text ?? '';
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    // A refusal is often plain prose rather than JSON — surface it verbatim
    // instead of collapsing it to a generic failure.
    parsed = null;
  }
  if (!parsed) {
    const fallback = text.trim() || 'Fleet launch failed — no response from the launcher.';
    return { ok: false, message: fallback };
  }
  const opened = Array.isArray(parsed.opened) ? parsed.opened.length : 0;
  const failed = Array.isArray(parsed.failed) ? parsed.failed.length : 0;
  const fleet = typeof parsed.fleet === 'string' ? parsed.fleet : 'fleet';
  if (parsed.ok === true && opened > 0) {
    const suffix = failed > 0 ? ` (${failed} failed to open)` : '';
    return { ok: true, message: `Launched ${opened} member${opened === 1 ? '' : 's'} on “${fleet}”${suffix}.` };
  }
  // `message` is the tool's own composed explanation (capacity clamps, missing
  // lane, a refused model/agent pairing) — far better copy than anything this
  // component could invent from the status code.
  const why = typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : null;
  return { ok: false, message: why ?? `Fleet launch opened no members on “${fleet}”.` };
}

export interface FleetLaunchRowProps {
  className?: string;
  /** Called after a launch that opened at least one member — lets a host refresh
   *  a roster that is not already sync-driven. */
  onLaunched?: (fleetSlug: string | null) => void;
}

/**
 * The always-visible fleet-launch row. Self-contained: its own option fetches,
 * its own URL-backed selection state, its own launch call — so it drops into any
 * chat surface with no props.
 */
export default function FleetLaunchRow({ className, onLaunched }: FleetLaunchRowProps) {
  // Selections live in the URL (see the module header). Prefixed keys so they
  // cannot collide with the ~180 params already in use across this app.
  const [fleetName, setFleetName] = useQueryState('fleetName', parseAsString.withDefault(''));
  const [planSlug, setPlanSlug] = useQueryState('fleetPlan', parseAsString);
  const [model, setModel] = useQueryState('fleetModel', parseAsString.withDefault(''));
  const [account, setAccount] = useQueryState(
    'fleetAccount',
    parseAsString.withDefault(ACCOUNT_SELECT_DEFAULT),
  );
  const [headless, setHeadless] = useQueryState('fleetHeadless', parseAsBoolean.withDefault(false));
  const [count, setCount] = useQueryState('fleetCount', parseAsInteger.withDefault(1));

  // Launch lifecycle is render-only — useState is correct here (CLAUDE.md's
  // split puts loading/saving state on the local side of the line).
  const [launching, setLaunching] = useState(false);

  // psu's own account pool, keyed to the backend the picked model implies —
  // pool pinning is per-backend, exactly as the new-session row resolves it.
  const launchOptions = useSuLaunchOptions(null, modelBackend(model) ?? 'claude');
  const accountOptions = useMemo(
    () => buildAccountOptions(launchOptions.accounts),
    [launchOptions.accounts],
  );

  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const selectedPlan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === planSlug) ?? null,
    [planSlug, planList.data],
  );
  const planOptions = useMemo(
    () => buildLaunchPlanOptions(planList.data?.plans ?? [], selectedPlan?.harness ?? null, planList.loading),
    [planList.data, planList.loading, selectedPlan],
  );

  const launch = useCallback(async () => {
    if (launching) return;
    // A fleet needs a NAME (it becomes the durable handle) and a LANE. Both are
    // checked here so the human fixes them in the row rather than reading a
    // tool refusal — but they are still the tool's rules, not this row's: it
    // refuses a nameless fleet, and refuses a launch with neither `plan` nor
    // `claimKinds` because members would otherwise drain the whole backlog.
    if (!fleetName.trim()) {
      toast.error('Name the fleet — that name becomes its durable handle.');
      return;
    }
    if (!selectedPlan) {
      toast.error('Pick a plan — it is the lane the members work.');
      return;
    }
    setLaunching(true);
    try {
      const r = await fetch(FLEET_LAUNCH_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: fleetName.trim(),
          plan: selectedPlan.slug,
          // The plan's OWN harness, not an ambient one: this route has no agent
          // session to inherit a harness scope from, and the tool needs the
          // harness the plan actually belongs to in order to resolve it.
          ...(selectedPlan.harness ? { harness: selectedPlan.harness } : {}),
          count: clampMemberCount(count),
          headless,
          // Always sent — a psu launch with no --account opens an interactive
          // picker that would hang every spawned member waiting for a human.
          account: account || ACCOUNT_SELECT_DEFAULT,
          ...(model && model !== MODEL_SELECT_DEFAULT ? { model } : {}),
          // The model implies its backend (the menu spans claude/codex/omp), and
          // sending the model without it launches the WRONG CLI nominally set to
          // an unrunnable id — the trap that spawned 4 mislabelled members on
          // 2026-07-03. Send both, derived from the same menu.
          ...(modelBackend(model) ? { agent: modelBackend(model) } : {}),
        }),
      });
      const body = await r.json().catch(() => null);
      const verdict = describeLaunchResult(body);
      if (verdict.ok) {
        toast.success(verdict.message, { duration: 4000 });
        // A launch that CREATED the fleet added a row to the picker source —
        // re-read it so the new fleet is immediately joinable elsewhere.
        launchOptions.refresh();
        onLaunched?.(fleetName.trim() || null);
      } else {
        toast.error(verdict.message, { duration: 8000 });
      }
    } catch (e) {
      toast.error(`Fleet launch failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaunching(false);
    }
  }, [
    launching,
    fleetName,
    selectedPlan,
    count,
    headless,
    account,
    model,
    launchOptions,
    onLaunched,
  ]);

  return (
    <div
      className={`pc-fleet-launch-row${className ? ` ${className}` : ''}`}
      data-testid="fleet-launch-row"
      aria-label="Launch a fleet"
    >
      <span className="pc-fleet-launch-row__label">Fleet</span>
      {/* Reuses the new-session row's own control classes (hud.css, already
          imported by SessionChatModal) so the two launchers render as the same
          control strip rather than as two different-looking forms. */}
      <div className="pc-new-session-launcher pc-fleet-launch-row__controls">
        <input
          className="pc-new-session-launcher__input"
          type="text"
          value={fleetName}
          onChange={(e) => void setFleetName(e.target.value)}
          placeholder="Fleet name"
          aria-label="Name for the new fleet"
          data-testid="fleet-launch-name"
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--plan"
          value={planSlug ?? PLAN_SELECT_PLACEHOLDER}
          emptyValue={PLAN_SELECT_PLACEHOLDER}
          onChange={(value) => void setPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
          disabled={planList.loading}
          ariaLabel="Plan the fleet works"
          placeholder={planList.loading ? 'Loading plans…' : 'Select plan…'}
          emptyLabel="No plans match"
          options={planOptions}
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--model"
          value={model || MODEL_SELECT_DEFAULT}
          emptyValue={MODEL_SELECT_DEFAULT}
          onChange={(value) => void setModel(value === MODEL_SELECT_DEFAULT ? '' : value)}
          ariaLabel="Model for every fleet member"
          placeholder="Default"
          emptyLabel="No models match"
          options={OMP_MODEL_OPTIONS}
        />
        {/* The owner's fifth option — "default system account or pin to an
            account using the inference gateway" — IS this control: its rows are
            `default` (system/CLI login, gateway skipped), `auto` (gateway-routed
            with failover) and every pool account (a hard gateway pin). One
            control, because psu's --account is one flag with three modes. */}
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--account"
          value={account}
          emptyValue={ACCOUNT_SELECT_DEFAULT}
          onChange={(value) => void setAccount(value)}
          ariaLabel="Account routing for every fleet member"
          placeholder="Default account"
          emptyLabel="No accounts match"
          options={accountOptions}
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--window"
          value={headless ? HEADLESS_VALUE : HEADED_VALUE}
          onChange={(value) => void setHeadless(value === HEADLESS_VALUE)}
          ariaLabel="Headed or headless members"
          placeholder="Headed"
          emptyLabel="No modes match"
          options={WINDOW_MODE_OPTIONS}
        />
        <input
          className="pc-new-session-launcher__input pc-fleet-launch-row__count"
          type="number"
          min={1}
          max={FLEET_MAX_MEMBERS}
          value={count}
          // Clamped on COMMIT, not on every keystroke: clamping as you type makes
          // the field impossible to clear and retype (a "1" you are turning into
          // "12" snaps back), so the raw value is held and bounded at launch.
          onChange={(e) => void setCount(Number.parseInt(e.target.value, 10) || 1)}
          onBlur={() => void setCount(clampMemberCount(count))}
          aria-label="How many members to launch"
          title={`How many members (1–${FLEET_MAX_MEMBERS})`}
          data-testid="fleet-launch-count"
        />
        <Button
          variant="primary"
          size="sm"
          className="pc-new-session-launcher__btn"
          onClick={() => void launch()}
          disabled={launching}
          data-testid="fleet-launch-submit"
        >
          {launching ? 'Launching…' : '+ Launch fleet'}
        </Button>
      </div>
    </div>
  );
}
