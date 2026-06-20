/**
 * Gateway-control harness (B-X-1) — the shared cross-cutting wrapper every gateway/account
 * control tool composes (gateway-live-control-and-egress-plan-2026-06-20 D-005).
 *
 * The whole point of the live-control surface is UNSUPERVISED agent self-correction, which is
 * only safe with four guarantees on every mutating tool (D-005): a **dryRun preview**, a
 * **post-apply verify**, an **audit record** (who/what/prev/ts), and a **one-call revert**.
 * Rather than re-implement those per tool, each control tool describes its mutation as a
 * `ControlMutationSpec` (capturePrev / apply / revertTo / verify / describe callbacks) and runs
 * it through `runControlMutation`, which orchestrates the four guarantees uniformly.
 *
 * GENERIC BY DESIGN: the harness knows nothing about accounts, egress, or AIMD — the consumer
 * supplies the callbacks. So B-EGRESS (`accounts:set-egress`), B-ACCT (`accounts:exclude`), and
 * B-GWCTL (`gateway:set-aimd` / `set-admission`) all compose the SAME harness; the per-domain
 * DB write / version-bump / reload lives in the consumer's `apply`/`revertTo`.
 *
 * REUSE-FIRST (agents-reuse-first-default): the audit record is written to the EXISTING
 * `harness_shared.audit_log` store (the `details` jsonb carries prev+next for the revert) — NOT
 * a new "control-audit" table. The write mirrors operator-audit.ts's pattern; it is injectable
 * (`deps.writeAudit`) so the orchestration is unit-testable with no DB.
 *
 * The audit write is keyed by the action namespace `gateway-control.<action>` so `audit:list`
 * (and the operator surface) surfaces control actions distinctly from operator-card events.
 */
import { withWorkspace, generated } from '@papercusp/db-org';
import { drizzle } from 'drizzle-orm/postgres-js';
import { activeWorkspaceId } from '../workspace-registry';

const al = generated.auditLogInHarnessShared;

/** The result of a control tool's post-apply verification (echo IP, /admin/config reflects it…). */
export interface ControlVerify {
  ok: boolean;
  detail?: string;
}

/**
 * A control mutation, described by its consumer. `T` is the consumer's value type (the thing
 * captured/applied/reverted — e.g. an account's egress config, the pool's AIMD params).
 */
export interface ControlMutationSpec<T> {
  /** Stable action name — the audit action + the dryRun/result label, e.g. 'gateway:set-aimd'. */
  action: string;
  /** Audit subject — what the mutation targets (an accountId, 'pool', 'gateway'). */
  subject: string;
  /** Who is making the change (audit actor). Defaults to 'system:gateway-control'. */
  actor?: string;
  /** Read the CURRENT value — captured before apply, and the value `revert` replays. */
  capturePrev: () => Promise<T>;
  /** Perform the mutation (DB write + version-bump/reload). Returns the new effective value. */
  apply: () => Promise<T>;
  /** Re-apply a previously-captured value (the revert primitive). */
  revertTo: (prev: T) => Promise<void>;
  /** Post-apply proof the change took effect. Omit for a mutation with no external check. */
  verify?: (next: T) => Promise<ControlVerify>;
  /** dryRun preview: describe what WOULD change, given the current value, WITHOUT applying. */
  describe?: (prev: T) => unknown;
}

export interface ControlOutcome<T> {
  action: string;
  subject: string;
  dryRun: boolean;
  /** Whether the mutation is in effect now (false on dryRun, or if an auto-revert undid it). */
  applied: boolean;
  /** The value before the mutation (and, on a successful apply, the revert target). */
  prev: T;
  /** The new effective value (absent on dryRun). */
  next?: T;
  /** Post-apply verification result (absent on dryRun or when the spec has no verify). */
  verify?: ControlVerify;
  /** The audit_log row id this mutation wrote (absent on dryRun). */
  auditId?: string;
  /** True when a failed verify (with verifyMustPass) auto-reverted the change. */
  reverted?: boolean;
  /** dryRun only: the consumer's `describe(prev)` output — what would change. */
  preview?: unknown;
  /** One-call revert of THIS mutation (re-applies prev + writes a `<action>:revert` audit row).
   *  Absent on dryRun or when the apply was auto-reverted. */
  revert?: () => Promise<ControlOutcome<T>>;
}

export interface RunControlOpts {
  /** Preview only — capture + describe, never apply/audit. */
  dryRun?: boolean;
  /** When the spec has a verify and it FAILS, auto-revert the change (fail-safe). Default true. */
  verifyMustPass?: boolean;
}

export interface ControlHarnessDeps {
  /** Injectable audit writer (default: the real audit_log write). Tests pass a fake. */
  writeAudit?: (rec: ControlAuditRecord) => Promise<string>;
}

export interface ControlAuditRecord {
  action: string;
  subject: string;
  actor: string;
  prev: unknown;
  next: unknown;
  verify?: ControlVerify;
  reverted?: boolean;
  /** Set on a revert's own audit row — the audit id of the mutation being reverted. */
  revertOf?: string;
}

const DEFAULT_ACTOR = 'system:gateway-control';

function auditId(): string {
  return `gwc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Write a control mutation to the shared audit_log (reuse-first). `details` carries prev+next so
 * the action is fully reconstructable + revertible from the audit row. Best-effort like
 * operator-audit (a missing audit row must never fail the control action) but RETURNS the id so
 * the outcome can reference it; on write failure returns '' (the mutation still applied).
 */
export async function writeControlAudit(rec: ControlAuditRecord): Promise<string> {
  const workspaceId = activeWorkspaceId();
  const id = auditId();
  try {
    await withWorkspace(workspaceId, async (tx) => {
      await drizzle(tx)
        .insert(al)
        .values({
          id,
          ts: Date.now(),
          actor: rec.actor || DEFAULT_ACTOR,
          action: `gateway-control.${rec.action}`,
          subject: rec.subject,
          details: {
            prev: rec.prev,
            next: rec.next,
            ...(rec.verify ? { verify: rec.verify } : {}),
            ...(rec.reverted ? { reverted: true } : {}),
            ...(rec.revertOf ? { revert_of: rec.revertOf } : {}),
          } as never,
          workspaceId,
        });
    });
    return id;
  } catch (err) {
    console.warn(`[gateway-control] audit write failed for ${rec.action}/${rec.subject}:`, err);
    return '';
  }
}

/**
 * Run a control mutation with the four D-005 guarantees: dryRun preview · apply · post-apply
 * verify (auto-revert on failure when verifyMustPass) · audit · one-call revert.
 *
 * - dryRun: capture the current value + `describe(prev)`; never apply, never audit.
 * - apply:  capturePrev → apply → verify → (auto-revert on failed verify if verifyMustPass) →
 *           audit (prev+next) → return an outcome carrying a `revert()` that replays prev.
 *
 * Never silently swallows an `apply` throw — the consumer's apply is responsible for its own
 * atomicity (write-DB-and-apply-live); a throw propagates so the tool reports the failure.
 */
export async function runControlMutation<T>(
  spec: ControlMutationSpec<T>,
  opts: RunControlOpts = {},
  deps: ControlHarnessDeps = {},
): Promise<ControlOutcome<T>> {
  const actor = spec.actor || DEFAULT_ACTOR;
  const writeAudit = deps.writeAudit ?? writeControlAudit;
  const verifyMustPass = opts.verifyMustPass ?? true;

  const prev = await spec.capturePrev();

  if (opts.dryRun) {
    return {
      action: spec.action,
      subject: spec.subject,
      dryRun: true,
      applied: false,
      prev,
      preview: spec.describe ? spec.describe(prev) : undefined,
    };
  }

  const next = await spec.apply();
  const verify = spec.verify ? await spec.verify(next) : undefined;

  // Fail-safe: a mutation whose post-apply verify fails is auto-reverted (the change did not
  // demonstrably take effect) when verifyMustPass — so a bad live change never lingers.
  let reverted = false;
  if (verify && !verify.ok && verifyMustPass) {
    await spec.revertTo(prev);
    reverted = true;
  }

  const recordedId = await writeAudit({
    action: spec.action,
    subject: spec.subject,
    actor,
    prev,
    next,
    verify,
    reverted,
  });

  const outcome: ControlOutcome<T> = {
    action: spec.action,
    subject: spec.subject,
    dryRun: false,
    applied: !reverted,
    prev,
    next,
    verify,
    auditId: recordedId || undefined,
    reverted: reverted || undefined,
  };

  // One-call revert — only when the change is currently in effect (not already auto-reverted).
  if (!reverted) {
    outcome.revert = async (): Promise<ControlOutcome<T>> => {
      await spec.revertTo(prev);
      const revId = await writeAudit({
        action: `${spec.action}:revert`,
        subject: spec.subject,
        actor,
        prev: next, // before the revert, the value was `next`…
        next: prev, // …after the revert, it is `prev` again
        revertOf: recordedId || undefined,
      });
      return {
        action: `${spec.action}:revert`,
        subject: spec.subject,
        dryRun: false,
        applied: true,
        prev: next,
        next: prev,
        auditId: revId || undefined,
        reverted: true,
      };
    };
  }

  return outcome;
}
