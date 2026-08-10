/**
 * Launch settings, in the goal detail popup (goal-mode-hardening-2026-08-10
 * P-005, editing P-004's store).
 *
 * WHY HERE. D-007: "Goal settings live in the goal detail popup, beside
 * Subdirectives" [owner, interactive: "I meant inside the conversation popup
 * where it currently shows SUBDIRECTIVES"] — explicitly NOT the left rail, whose
 * Goals tab the owner removed on 2026-08-09; restoring it would re-create the
 * two-boards duplication that cut.
 *
 * WHAT THESE NUMBERS ARE. D-004 removed the GOAL contract's "capacity preflight,
 * ramp one at a time" clause and told the goal agent to parallelize maximally
 * instead. That is only safe because D-005 replaced the preflight with two
 * BINDING ceilings the machine enforces. So this form is not a preferences pane:
 * it is the only place a human sets the number that stops a goal agent from
 * launching an unbounded fleet, which is why the ceilings sit first and an unset
 * ceiling says "unlimited" out loud rather than rendering as a blank field.
 *
 * WHY IT WRITES THROUGH goals:update. The same reasoning admin/goals.ts gives for
 * proxying rather than hand-writing: `goals:update` merges partial fields, so
 * saving settings cannot clear a kill criterion, and the route already
 * invalidates `goals.detail` + `goals.list` on success. A dedicated settings
 * endpoint would be a second write path to the one row whose state decides
 * whether a fleet runs.
 *
 * THE OPTION LISTS COME FROM THE SERVER (D-011). `agent`, `carry` and
 * `contextSize` are closed sets in `launchProfileSchema`, and this file
 * deliberately does not spell them: they arrive as `launchSettingsOptions`,
 * derived from the schema's own constants. A hand-spelled copy here would be the
 * measured failure that decision is about — a list that falls behind the registry
 * and offers a value the write refuses, or hides one it accepts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { toast } from 'sonner';
import type {
  GoalDetailLaunchOptions,
  GoalDetailLaunchSettings,
} from './goal-detail-model';
import {
  emptyRoleForm,
  formToSettings,
  isSettingsDirty,
  settingsSummary,
  settingsToForm,
  PROFILE_CHOICE_FIELDS,
  PROFILE_FIELDS,
  PROFILE_FIELD_LABEL,
  type LaunchProfileForm,
  type LaunchRoleForm,
  type LaunchSettingsForm,
  type ProfileField,
} from './goal-launch-settings-model';

async function saveLaunchSettings(
  goalId: string,
  settings: GoalDetailLaunchSettings | null,
): Promise<void> {
  const res = await fetch('/api/admin/goals/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: goalId, launchSettings: settings }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* non-JSON body — the status alone is what we have */
    }
    throw new Error(detail);
  }
  /* ⚠ 200 IS NOT SUCCESS ON ITS OWN. The route replies with the tool's result
     VERBATIM, and `goals:update` reports a failed settings write as
     `degraded: true` with the reason — precisely so a caller cannot render a
     ceiling as saved when it was not. Flattening that to "ok" here would
     re-create the bug that seam exists to prevent. */
  const body = (await res.json().catch(() => null)) as
    | { degraded?: boolean; degradedReasons?: string[] }
    | null;
  if (body?.degraded) {
    throw new Error(body.degradedReasons?.join('; ') || 'the write reported itself degraded');
  }
}

function ProfileFields({
  idPrefix,
  value,
  options,
  disabled,
  onChange,
}: {
  idPrefix: string;
  value: LaunchProfileForm;
  options: GoalDetailLaunchOptions | null | undefined;
  disabled: boolean;
  onChange: (field: ProfileField, next: string) => void;
}) {
  return (
    <div className="hud-goal__set-grid">
      {PROFILE_FIELDS.map((field) => {
        const id = `${idPrefix}-${field}`;
        const choices = PROFILE_CHOICE_FIELDS.has(field)
          ? (options?.[field as 'agent' | 'carry' | 'contextSize'] ?? null)
          : null;
        return (
          <label key={field} className="hud-goal__set-field" htmlFor={id}>
            <span className="hud-goal__set-label">{PROFILE_FIELD_LABEL[field]}</span>
            {/* A closed-set field falls back to free text when the payload did
                not carry its options, rather than rendering an empty select the
                owner cannot use. Degraded, but still editable — and it cannot
                offer a wrong value, since the server validates either way. */}
            {choices && choices.length ? (
              <select
                id={id}
                className="hud-goal__set-in"
                value={value[field]}
                disabled={disabled}
                onChange={(e) => onChange(field, e.target.value)}
              >
                <option value="">system default</option>
                {choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                className="hud-goal__set-in"
                value={value[field]}
                disabled={disabled}
                placeholder="system default"
                maxLength={120}
                onChange={(e) => onChange(field, e.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

export default function GoalSettingsSection({
  goalId,
  settings,
  settingsInvalid,
  options,
}: {
  goalId: string;
  /** Null = nothing pinned (the launch default), NOT an error. */
  settings: GoalDetailLaunchSettings | null | undefined;
  /** Non-null = the stored document is unreadable, so NO ceiling is in force. */
  settingsInvalid?: string | null;
  options?: GoalDetailLaunchOptions | null;
}) {
  // Expansion state in the URL, per the repo's nuqs rule — which also makes the
  // editor reachable from the agent → UI control surface, since anything in
  // useState is invisible to `ui:get_state` / `ui:dispatch`.
  const [open, setOpen] = useQueryState('goalSettings', parseAsBoolean.withDefault(false));
  const [form, setForm] = useState<LaunchSettingsForm>(() => settingsToForm(settings));
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  /* TWO DIFFERENT QUESTIONS, AND CONFLATING THEM BREAKS THE RE-SYNC BELOW.
     `dirty` asks "does the form differ from what is STORED" — that is what the
     Save button is for. `edited` asks "has the owner typed since we loaded this
     form", measured against the document we last loaded FROM. They come apart
     exactly when the server changes underneath an untouched form: `dirty` goes
     true because the stored document moved, not because anyone typed. Guarding
     the re-sync on `dirty` therefore treats every external change as an edit in
     progress and the form never updates again. */
  const dirty = useMemo(() => isSettingsDirty(form, settings ?? null), [form, settings]);
  const syncedRef = useRef<GoalDetailLaunchSettings | null>(settings ?? null);
  const edited = useMemo(() => isSettingsDirty(form, syncedRef.current), [form]);

  /* RE-SYNC FROM THE SERVER, BUT NEVER OVER AN EDIT IN PROGRESS. `goals.detail`
     re-pulls on every invalidation — including ones this popup did not cause —
     so without this the form would keep showing a stale document after someone
     else changed it. The opposite failure is worse, which is why an edit wins:
     re-initialising mid-edit would delete what the owner is typing.

     `!dirty` is the second way in, and it is what un-sticks the form after our
     OWN save: the form then already equals the incoming document, so adopting
     it changes nothing on screen but advances the ref — without it, `edited`
     would stay true against a stale ref forever and later external changes
     would never land. */
  useEffect(() => {
    const incoming = settings ?? null;
    if (JSON.stringify(incoming) === JSON.stringify(syncedRef.current)) return;
    if (edited && dirty) return;
    syncedRef.current = incoming;
    setForm(settingsToForm(incoming));
    setProblems([]);
  }, [settings, edited, dirty]);

  const setDefaultsField = useCallback((field: ProfileField, next: string) => {
    setForm((f) => ({ ...f, defaults: { ...f.defaults, [field]: next } }));
  }, []);

  const setRoleField = useCallback((key: string, field: ProfileField | 'role', next: string) => {
    setForm((f) => ({
      ...f,
      roles: f.roles.map((r) => (r.key === key ? { ...r, [field]: next } : r)),
    }));
  }, []);

  const addRole = useCallback(() => {
    setForm((f) => ({ ...f, roles: [...f.roles, emptyRoleForm()] }));
  }, []);

  const removeRole = useCallback((key: string) => {
    setForm((f) => ({ ...f, roles: f.roles.filter((r) => r.key !== key) }));
  }, []);

  const reset = useCallback(() => {
    setForm(settingsToForm(settings));
    setProblems([]);
  }, [settings]);

  const save = useCallback(async () => {
    if (busy) return;
    const { settings: doc, problems: found } = formToSettings(form);
    setProblems(found);
    if (found.length) return;
    setBusy(true);
    try {
      await saveLaunchSettings(goalId, doc);
      // No local cache write: the route invalidates goals.detail server-side, so
      // the re-sync above pulls the stored document back and the form ends up
      // showing what was actually persisted rather than what we sent.
      toast.success(doc ? 'Launch settings saved' : 'Launch settings cleared');
    } catch (e) {
      toast.error('Could not save launch settings', { description: String(e) });
    } finally {
      setBusy(false);
    }
  }, [busy, form, goalId]);

  const summary = settingsSummary(settings);

  return (
    <section className="hud-goal__section" data-testid="goal-settings-section">
      <h3 className="hud-goal__h">
        Launch settings
        <button
          type="button"
          className="hud-goal__set-toggle"
          aria-expanded={open}
          onClick={() => void setOpen(open ? null : true)}
        >
          {open ? 'Done' : 'Edit'}
        </button>
      </h3>

      {/* The ceilings restated as a sentence, because a number in a form field
          does not say what it governs — and this one governs whether the agent
          may keep launching. */}
      <p className="hud-goal__note">
        What this goal’s agent may launch. The ceilings count EVERY live session on the goal, fleet
        members included, and a launch that would breach one is refused.
      </p>

      {settingsInvalid ? (
        /* Not folded into "no settings": an unreadable document means the
           owner's ceiling is NOT being enforced, and the two states look
           identical while meaning opposite things. Saying so is the whole
           point — see the store's fail-open note. */
        <p className="hud-goal__set-alarm" data-testid="goal-settings-invalid">
          ⚠ The stored launch settings could not be read, so <strong>no ceiling is in force</strong>.
          Saving below replaces the unreadable document. ({settingsInvalid})
        </p>
      ) : null}

      {!open ? (
        <p className="hud-goal__set-summary" data-testid="goal-settings-summary">
          {summary}
        </p>
      ) : (
        <div className="hud-goal__set">
          <div className="hud-goal__set-grid">
            <label className="hud-goal__set-field" htmlFor={`gs-${goalId}-maxAgents`}>
              <span className="hud-goal__set-label">Max agents</span>
              <input
                id={`gs-${goalId}-maxAgents`}
                className="hud-goal__set-in"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={form.maxAgents}
                disabled={busy}
                placeholder="unlimited"
                onChange={(e) => setForm((f) => ({ ...f, maxAgents: e.target.value }))}
              />
            </label>
            <label className="hud-goal__set-field" htmlFor={`gs-${goalId}-maxPerFleet`}>
              <span className="hud-goal__set-label">Max per fleet</span>
              <input
                id={`gs-${goalId}-maxPerFleet`}
                className="hud-goal__set-in"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={form.maxPerFleet}
                disabled={busy}
                placeholder="unlimited"
                onChange={(e) => setForm((f) => ({ ...f, maxPerFleet: e.target.value }))}
              />
            </label>
          </div>

          <h4 className="hud-goal__set-h">Default launch profile</h4>
          <p className="hud-goal__note">
            Applied to every agent this goal launches. A launch that asks for something specific
            still wins — these are the goal’s standing policy, not an override.
          </p>
          <ProfileFields
            idPrefix={`gs-${goalId}-def`}
            value={form.defaults}
            options={options}
            disabled={busy}
            onChange={setDefaultsField}
          />

          <h4 className="hud-goal__set-h">Per-role profiles</h4>
          <p className="hud-goal__note">
            Override the defaults for one role. More specific than the defaults, less than what a
            launch explicitly asks for.
          </p>
          {form.roles.length === 0 ? (
            <p className="hud-goal__empty">No per-role profiles — every role uses the defaults.</p>
          ) : (
            form.roles.map((r: LaunchRoleForm) => (
              <div key={r.key} className="hud-goal__set-role">
                <div className="hud-goal__set-rolehead">
                  <label className="hud-goal__set-field" htmlFor={`gs-${goalId}-${r.key}-role`}>
                    <span className="hud-goal__set-label">Role</span>
                    <input
                      id={`gs-${goalId}-${r.key}-role`}
                      className="hud-goal__set-in"
                      value={r.role}
                      disabled={busy}
                      placeholder="e.g. engineer"
                      maxLength={64}
                      onChange={(e) => setRoleField(r.key, 'role', e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="hud-goal__set-remove"
                    disabled={busy}
                    onClick={() => removeRole(r.key)}
                    aria-label={`Remove role profile ${r.role || '(unnamed)'}`}
                  >
                    Remove
                  </button>
                </div>
                <ProfileFields
                  idPrefix={`gs-${goalId}-${r.key}`}
                  value={r}
                  options={options}
                  disabled={busy}
                  onChange={(field, next) => setRoleField(r.key, field, next)}
                />
              </div>
            ))
          )}
          <button type="button" className="hud-goal__set-add" disabled={busy} onClick={addRole}>
            Add role profile
          </button>

          {problems.length ? (
            <ul className="hud-goal__set-problems" data-testid="goal-settings-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}

          <div className="hud-goal__set-actions">
            <button
              type="button"
              className="hud-goal__addsub-go"
              disabled={busy || !dirty}
              onClick={() => void save()}
            >
              {busy ? 'Saving…' : 'Save settings'}
            </button>
            <button
              type="button"
              className="hud-goal__set-remove"
              disabled={busy || !dirty}
              onClick={reset}
            >
              Revert
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
