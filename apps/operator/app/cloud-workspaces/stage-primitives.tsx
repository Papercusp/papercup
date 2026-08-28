"use client";

/**
 * Presentation primitives shared by the three rail stages.
 *
 * Lifted verbatim (behaviour-wise) out of `page.tsx` so a stage never has to
 * re-implement label/hint/describedby wiring — the describedby contract is an
 * accessibility invariant the suite pins, and one implementation is the only
 * way it stays true across three files.
 */

import { useId } from "react";
import {
  formatSignal,
  isLifecycleState,
  stateTone,
  type ConnectionStatus,
} from "./workspace-view-model";
import styles from "./cloud-workspaces.module.css";

export function SignalList({
  items,
  empty,
}: {
  items?: unknown[];
  empty: string;
}) {
  if (!items?.length) return <p className={styles.telemetryEmpty}>{empty}</p>;
  return (
    <ul className={styles.signalList}>
      {items.map((item, index) => (
        <li key={`${index}:${formatSignal(item)}`}>{formatSignal(item)}</li>
      ))}
    </ul>
  );
}

export function StatusBadge({
  state,
  prefix,
}: {
  state: string;
  prefix?: string;
}) {
  const normalized = isLifecycleState(state)
    ? state
    : (state as ConnectionStatus);
  return (
    <span className={`${styles.badge} ${styles[stateTone(normalized)]}`}>
      {prefix ? `${prefix}: ` : ""}
      {state}
    </span>
  );
}

/**
 * A labelled control whose hint is wired to it by id. `children` may be a
 * render function so the caller can spread the generated hint id onto whatever
 * control it owns — that is what keeps `aria-describedby` correct without the
 * primitive knowing the control's type.
 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode | ((hintId: string | undefined) => React.ReactNode);
  hint?: string;
}) {
  const generatedHintId = useId();
  const hintId = hint ? generatedHintId : undefined;

  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {typeof children === "function" ? children(hintId) : children}
      {hint ? (
        <span id={hintId} className={styles.fieldHint}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/** The heading every stage opens with: step index, name, and what it does. */
export function StageHeader({
  id,
  step,
  eyebrow,
  title,
  description,
}: {
  id: string;
  step: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className={styles.stageHeader}>
      <div className={styles.stageHeaderCopy}>
        <p className={styles.stageEyebrow}>
          <span className={styles.stageNumber} aria-hidden="true">
            {step}
          </span>
          {eyebrow}
        </p>
        <h2 id={id}>{title}</h2>
        <p className={styles.stageDescription}>{description}</p>
      </div>
    </div>
  );
}

/** A group of related fields inside a stage — Placement, Capacity, Storage. */
export function FieldGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section className={styles.fieldGroup} aria-labelledby={headingId}>
      <div className={styles.fieldGroupHeading}>
        <h3 id={headingId}>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </div>
      <div className={styles.fieldGroupBody}>{children}</div>
    </section>
  );
}
