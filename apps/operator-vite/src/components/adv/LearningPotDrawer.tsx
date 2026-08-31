/**
 * The per-pot learning drawer (learning-pot-scope-gate-2026-08-30, P-012).
 *
 * The rail's popover (P-007) is a cramped arm/disarm panel hanging off a chip.
 * This is the full surface: master switch first, then every lane the pot owns
 * as a REAL FIELD — armed state, a budget you can type with its unit spelled
 * out, who enforces it, what it has spent.
 *
 * ⚠ WHY THE TRIGGER MATTERS MORE THAN THE PANEL. D-008 recorded that the rail
 * cannot collapse its switched-off pots — the owner's "gigantic display"
 * complaint — because the chip popover is the ONLY surface that operates
 * per-lane switches, and D-007 keeps per-lane control off the picker on
 * purpose. Two attempts to bury off pots were falsified by
 * LearningPotRail.test.tsx for exactly that reason. So this drawer opens from
 * the every-pot PICKER, by slug, for a pot with no chip at all. That is what
 * unblocks P-052; a drawer reachable only from a chip would reproduce the
 * dependency it exists to break.
 *
 * WHY OPENING FROM THE PICKER CLOSES IT. Both are Radix dialogs, and nesting
 * one inside the other stacks two aria-modal layers over each other — the
 * second traps focus inside the first's subtree and every control behind it
 * goes unreachable to a test and to a screen reader alike. The drawer therefore
 * REPLACES the picker and offers an explicit way back, which is also the
 * honest URL: exactly one of `lpick` / `lpot` is ever set.
 *
 * ARM AND BUDGET ARE SEPARATE WRITES, ON PURPOSE. `gym:arm` / `governor:arm`
 * both accept `enabled` and `budgetUsd` and refuse a call carrying neither.
 * Arming is a click; a budget is typed, and typing is not a decision until it
 * is submitted — a spend control that wrote on blur would let a stray focus
 * change alter a budget. So each budget field has its own explicit Save.
 */
import { useCallback, useMemo, useState } from "react";
import { parseAsBoolean, parseAsString, useQueryState } from "nuqs";
import { useSyncQuery } from "@papercusp/sync";
import type { AutomationCatalog } from "@papercusp/operator-core/lib/automation/catalog";
import { Modal } from "@/app/harness/Modal";
import { potHomeLabel } from "@/lib/pot-label";
import { useLexicon } from "@/lib/useLexicon";
import { runAgentTool } from "./run-tool";
import {
  buildPotDrawer,
  type PotDrawerField,
  type PotDrawerSection,
} from "./learning-pot-drawer";

/**
 * URL keys. Repo convention puts dialog open-state in nuqs so the agent control
 * surface can see and drive it. `lpot` carries the POT SLUG rather than a
 * boolean, because "which pot" is the whole state — and it is what lets the
 * picker hand a dormant pot straight here.
 */
const DRAWER_KEY = "lpot";
/** The picker's own open key — imported as a literal to avoid a component cycle. */
const PICKER_KEY = "lpick";

/** Open the drawer for one pot from anywhere (the picker's rows; the rail popover). */
export function useOpenPotDrawer(): (potSlug: string) => void {
  const [, setPot] = useQueryState(DRAWER_KEY, parseAsString.withDefault(""));
  const [, setPicker] = useQueryState(PICKER_KEY, parseAsBoolean.withDefault(false));
  return useCallback(
    (potSlug: string) => {
      // Close the picker in the same commit — see the header on nested dialogs.
      void setPicker(false);
      void setPot(potSlug);
    },
    [setPot, setPicker],
  );
}

function moneyText(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}

/**
 * One budget field. The draft is component-local because it is a mid-edit
 * value, which is the one category the repo's nuqs rule explicitly leaves in
 * useState — and putting a half-typed number in the URL would also make every
 * keystroke a history entry.
 */
function BudgetEditor({
  field,
  busy,
  onSave,
}: {
  field: PotDrawerField;
  busy: boolean;
  onSave: (usd: number | null) => void;
}) {
  const stored = field.budget.usd === null ? "" : String(field.budget.usd);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? stored;
  const trimmed = text.trim();

  // An empty box CLEARS the budget, which is a real and destructive-ish action
  // (the governor then refuses the lane), so it is a valid value rather than a
  // validation error — and the button says which of the two it will do.
  const parsed = trimmed === "" ? null : Number(trimmed);
  const invalid =
    parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000);
  const dirty = trimmed !== stored.trim();

  return (
    <div className="pc-potdraw__budget">
      <label className="pc-potdraw__blabel">
        <span className="pc-potdraw__bunit">{field.budget.unit}</span>
        <input
          className="pc-potdraw__binput"
          type="text"
          inputMode="decimal"
          value={text}
          placeholder="none"
          disabled={busy}
          aria-label={`Budget for ${field.label} in ${field.budget.unit}`}
          aria-invalid={invalid || undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="pc-potdraw__save"
        disabled={busy || invalid || !dirty}
        onClick={() => {
          onSave(parsed);
          setDraft(null);
        }}
      >
        {parsed === null ? "Clear" : "Save"}
      </button>
      {invalid ? (
        <span className="pc-potdraw__bad" role="alert">
          Enter a number between 0 and 100000, or leave it empty to clear.
        </span>
      ) : null}
    </div>
  );
}

function FieldRow({
  field,
  busyKey,
  anyBusy,
  onArm,
  onBudget,
}: {
  field: PotDrawerField;
  busyKey: string | null;
  anyBusy: boolean;
  onArm: (field: PotDrawerField, next: boolean) => void;
  onBudget: (field: PotDrawerField, usd: number | null) => void;
}) {
  const busy = busyKey === field.key;
  return (
    <li
      className="pc-potdraw__field"
      data-key={field.key}
      data-armed={field.armed === null ? "n/a" : field.armed ? "1" : "0"}
    >
      <div className="pc-potdraw__head">
        <span className="pc-potdraw__name">{field.label}</span>
        {field.ref ? (
          <code className="pc-potdraw__ref" title="The id this control writes by">
            {field.ref}
          </code>
        ) : null}
        {field.armed === null ? null : (
          <span className="pc-potdraw__state" data-on={field.armed ? "1" : "0"}>
            {field.armed ? "armed" : "disarmed"}
          </span>
        )}
        {field.write && field.armed !== null ? (
          <button
            type="button"
            className="pc-potdraw__arm"
            disabled={anyBusy}
            aria-pressed={field.armed}
            onClick={() => onArm(field, !field.armed)}
            aria-label={`${field.armed ? "Disarm" : "Arm"} ${field.label}`}
          >
            {busy ? "…" : field.armed ? "Disarm" : "Arm"}
          </button>
        ) : null}
      </div>

      {/* Enforcement is STATED, never implied by a badge colour — 'native' and
          'governor' gate a lane in genuinely different places. */}
      <p className="pc-potdraw__enf">{field.enforcementNote}</p>

      {field.write ? (
        <BudgetEditor field={field} busy={anyBusy} onSave={(usd) => onBudget(field, usd)} />
      ) : (
        <p className="pc-potdraw__ro">
          <span className="pc-potdraw__bunit">{field.budget.unit}</span>{" "}
          <strong>{moneyText(field.budget.usd)}</strong> — {field.readOnlyReason}
        </p>
      )}

      <p className="pc-potdraw__meta">
        <span>spent {moneyText(field.budget.spentUsd)}</span>
        {field.budget.remainingUsd !== null ? (
          <span>remaining {moneyText(field.budget.remainingUsd)}</span>
        ) : (
          // Never a blank cell: a blank invites the next reader to "helpfully"
          // fill it in with budget − spent, which is wrong for a per-cycle cap.
          <span className="pc-potdraw__why">{field.budget.remainingNote}</span>
        )}
        {field.status ? <span>{field.status}</span> : null}
      </p>
    </li>
  );
}

function SectionBlock({
  section,
  busyKey,
  anyBusy,
  onArm,
  onBudget,
}: {
  section: PotDrawerSection;
  busyKey: string | null;
  anyBusy: boolean;
  onArm: (field: PotDrawerField, next: boolean) => void;
  onBudget: (field: PotDrawerField, usd: number | null) => void;
}) {
  return (
    <section className="pc-potdraw__sec" data-section={section.id} aria-label={section.title}>
      <h3 className="pc-potdraw__sectitle">{section.title}</h3>
      <p className="pc-potdraw__secnote">{section.note}</p>
      {section.fields.length > 0 ? (
        <ul className="pc-potdraw__fields">
          {section.fields.map((f) => (
            <FieldRow
              key={f.key}
              field={f}
              busyKey={busyKey}
              anyBusy={anyBusy}
              onArm={onArm}
              onBudget={onBudget}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default function LearningPotDrawer() {
  const t = useLexicon();
  const [potSlug, setPotSlug] = useQueryState(DRAWER_KEY, parseAsString.withDefault(""));
  const [, setPicker] = useQueryState(PICKER_KEY, parseAsBoolean.withDefault(false));
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const catalogQuery = useSyncQuery<AutomationCatalog>({
    queryName: "automation.catalog",
    args: {},
    staleTime: 15_000,
  });
  const arming = catalogQuery.data?.[0]?.arming ?? null;

  const open = potSlug !== "";
  const model = useMemo(() => buildPotDrawer(arming, potSlug), [arming, potSlug]);

  const run = useCallback(
    async (key: string, tool: string, args: Record<string, unknown>) => {
      setBusyKey(key);
      setErr(null);
      try {
        await runAgentTool(tool, args);
        catalogQuery.invalidate?.();
      } catch (e) {
        // Surface the refusal rather than rendering the old state as if the
        // write had landed — these tools refuse an unknown slug/loopId on
        // purpose, so a typo must not read as a successful change.
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyKey(null);
      }
    },
    [catalogQuery],
  );

  const onArm = useCallback(
    (field: PotDrawerField, next: boolean) => {
      if (!field.write) return;
      const args =
        field.write.tool === "gym:arm"
          ? { harness: field.write.harness, enabled: next }
          : { loopId: field.write.loopId, enabled: next };
      void run(field.key, field.write.tool, args);
    },
    [run],
  );

  const onBudget = useCallback(
    (field: PotDrawerField, usd: number | null) => {
      if (!field.write) return;
      const args =
        field.write.tool === "gym:arm"
          ? { harness: field.write.harness, budgetUsd: usd }
          : { loopId: field.write.loopId, budgetUsd: usd };
      void run(field.key, field.write.tool, args);
    },
    [run],
  );

  const setMaster = useCallback(
    (enabled: boolean) => {
      void run("master", "learning:set-pot-scope", { pots: [potSlug], enabled });
    },
    [run, potSlug],
  );

  const close = useCallback(() => {
    void setPotSlug("");
    setErr(null);
  }, [setPotSlug]);

  const backToPicker = useCallback(() => {
    void setPotSlug("");
    void setPicker(true);
    setErr(null);
  }, [setPotSlug, setPicker]);

  const label = open ? potHomeLabel(potSlug) : "";
  const master = model.learning;
  const anyBusy = busyKey !== null;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      title={`Learning — ${label}`}
      contentClassName="pc-potdraw"
    >
      <div className="pc-potdraw__body">
        {/* MASTER SWITCH FIRST — everything below is ANDed with it, so reading
            the panel top-to-bottom reads the actual logic (plan Design). */}
        <div className="pc-potdraw__master" data-state={master}>
          <span className="pc-potdraw__mname">
            Learning for this {t("pot", { lower: true })}
          </span>
          <span className="pc-potdraw__mstate">
            {master === "on" ? "on" : master === "off" ? "off" : "unreadable"}
          </span>
          {master === "unknown" ? (
            // An unreadable scope cannot be a two-state switch without asserting
            // a position we never read — but the WRITE is well defined, so both
            // explicit actions stay available. Disabling here would make a
            // failed read unrecoverable from the surface that can fix it.
            <span className="pc-potdraw__mfix">
              <button type="button" disabled={anyBusy} onClick={() => setMaster(true)}>
                Switch on
              </button>
              <button type="button" disabled={anyBusy} onClick={() => setMaster(false)}>
                Switch off
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="pc-potdraw__marm"
              disabled={anyBusy}
              aria-pressed={master === "on"}
              aria-label={`${master === "on" ? "Switch off" : "Switch on"} learning for ${label}`}
              onClick={() => setMaster(master !== "on")}
            >
              {busyKey === "master" ? "…" : master === "on" ? "Switch off" : "Switch on"}
            </button>
          )}
        </div>

        <p className="pc-potdraw__note">
          {master === "unknown"
            ? "The pot switch could not be read, so every field below is unconfirmed. Setting it explicitly will resolve it."
            : master === "off"
              ? "Learning is off for this pot, so nothing below runs. Every lane keeps its own arming and budget — switching the pot back on restores exactly this, which is why these controls stay live."
              : "Each field below shows what that lane itself has armed. The effective answer is this switch AND the lane's own."}
        </p>

        {err ? (
          <p className="pc-potdraw__err" role="alert">
            {err}
          </p>
        ) : null}

        {model.sections.map((s) => (
          <SectionBlock
            key={s.id}
            section={s}
            busyKey={busyKey}
            anyBusy={anyBusy}
            onArm={onArm}
            onBudget={onBudget}
          />
        ))}

        <div className="pc-potdraw__footer">
          <button type="button" className="pc-potdraw__back" onClick={backToPicker}>
            ← All {t("pot", { plural: true, lower: true })}
          </button>
          <button type="button" className="pc-potdraw__done" onClick={close}>
            Done
          </button>
        </div>
      </div>

      <style>{`
        .pc-potdraw { width: min(680px, calc(100vw - 32px)); }
        .pc-potdraw__body { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
        .pc-potdraw__master {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; border-radius: 10px;
          border: 1px solid var(--border-strong); background: var(--bg-1);
        }
        .pc-potdraw__mname { flex: 1 1 auto; font-size: 13px; color: var(--fg); }
        .pc-potdraw__mstate { font-size: 11px; color: var(--fg-mute); }
        .pc-potdraw__master[data-state="on"] .pc-potdraw__mstate { color: var(--good); }
        .pc-potdraw__master[data-state="unknown"] .pc-potdraw__mstate { color: var(--warn); }
        .pc-potdraw__mfix { display: flex; gap: 6px; }
        .pc-potdraw__marm, .pc-potdraw__mfix button, .pc-potdraw__arm,
        .pc-potdraw__save, .pc-potdraw__back, .pc-potdraw__done {
          padding: 4px 10px; font-size: 12px; border-radius: 8px;
          border: 1px solid var(--border-strong); background: var(--bg);
          color: var(--fg); cursor: pointer;
        }
        .pc-potdraw__marm:disabled, .pc-potdraw__arm:disabled,
        .pc-potdraw__save:disabled, .pc-potdraw__mfix button:disabled {
          opacity: 0.5; cursor: default;
        }
        .pc-potdraw__note { margin: 0 2px; font-size: 11.5px; color: var(--fg-mute); line-height: 1.45; }
        .pc-potdraw__err { margin: 0 2px; font-size: 11.5px; color: var(--bad); }
        .pc-potdraw__sec { border-top: 1px solid var(--border); padding-top: 8px; }
        .pc-potdraw__sectitle { margin: 0 0 2px; font-size: 12.5px; color: var(--fg); }
        .pc-potdraw__secnote { margin: 0 0 6px; font-size: 10.5px; color: var(--fg-mute); line-height: 1.45; }
        .pc-potdraw__fields { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .pc-potdraw__field {
          border: 1px solid var(--border); border-radius: 10px;
          padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;
        }
        .pc-potdraw__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-potdraw__name { font-size: 12.5px; color: var(--fg); }
        .pc-potdraw__ref { font-size: 10px; color: var(--fg-mute); }
        .pc-potdraw__state { font-size: 10.5px; color: var(--fg-mute); margin-left: auto; }
        .pc-potdraw__state[data-on="1"] { color: var(--good); }
        .pc-potdraw__enf, .pc-potdraw__ro { margin: 0; font-size: 10.5px; color: var(--fg-mute); line-height: 1.45; }
        .pc-potdraw__budget { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .pc-potdraw__blabel { display: flex; align-items: center; gap: 6px; }
        .pc-potdraw__bunit { font-size: 10.5px; color: var(--fg-mute); }
        .pc-potdraw__binput {
          width: 110px; padding: 4px 8px; font-size: 12px;
          border-radius: 8px; border: 1px solid var(--border);
          background: var(--bg); color: var(--fg);
        }
        .pc-potdraw__binput[aria-invalid="true"] { border-color: var(--bad); }
        .pc-potdraw__bad { font-size: 10.5px; color: var(--bad); }
        .pc-potdraw__meta {
          margin: 0; display: flex; gap: 10px; flex-wrap: wrap;
          font-size: 10.5px; color: var(--fg-mute);
        }
        .pc-potdraw__why { flex: 1 1 200px; }
        .pc-potdraw__footer {
          display: flex; gap: 8px; padding-top: 8px;
          border-top: 1px solid var(--border);
        }
        .pc-potdraw__done { margin-left: auto; }
      `}</style>
    </Modal>
  );
}
