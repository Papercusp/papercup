/**
 * carry-respawn — the deterministic producer→consumer BRIDGE for the P-018
 * Claude-Code swap-in (deterministic-context-carry-2026-07-14, Phase 6).
 *
 * P-018's terminal shape is: disable Claude Code's native auto-compact, and have
 * psu watch context %, END the session at a threshold, and RESPAWN a successor
 * "with the built handoff as launch context". The live actuation half (the
 * ctx%-watch, the kill, the actual respawn, the gateway window-guard backstop)
 * runs in the psu-host loop and is verified by the Phase-7 cold-boot drills
 * (P-020). THIS module is the deterministic half that both the eventual live
 * respawn AND session:request-compaction share: given the already-built
 * {@link CarryDoc} (P-009/P-010/P-011 producers) it assembles the two things a
 * respawn actually delivers —
 *
 *   1. the SYSTEM-PROMPT ADDENDUM: the carry document rendered to the constant
 *      budget B ({@link renderCarryDoc} with {@link carryDocBudgetChars}), the
 *      successor's launch context (composeLaunchContext / --append-system-prompt-file);
 *   2. the successor's POSITIONAL FIRST PROMPT: the owner's FINAL message when it
 *      is still OPEN (P-010 "the final owner message becomes the successor's actual
 *      first prompt, never quoted material"), routed through the ONE shared kickoff
 *      source {@link deriveLaunchPromptText} so the respawn path and the plans:launch
 *      path can never drift.
 *
 * plus the P-010 OPEN-OWNER-QUESTION gate ({@link gateOpenOwnerQuestion}) the
 * DELIBERATE-boundary consumer must bounce on once before it cuts.
 *
 * PURE — every input is already assembled + bounded by buildCarryDoc; no DB, no
 * fs, no spawn. That is deliberate: the live respawn actuation (which is not
 * unit-testable without a host) stays in the psu-host; the ASSEMBLY it depends on
 * is testable in isolation here, exactly as the producers are.
 */
import {
  type BuildCarryDocOpts,
  type CarryDoc,
  type OpenOwnerQuestionGate,
  buildCarryDoc,
  carryDocBudgetChars,
  gateOpenOwnerQuestion,
  renderCarryDoc,
} from './carry-doc';
import { deriveLaunchPromptText, type LaunchPlanRef } from './agent-tools/plans/launch-prompt';

/** The two artifacts a successor respawn delivers, plus the boundary gate. */
export interface RespawnLaunchSpec {
  /**
   * The carry document rendered to the constant budget B — delivered to the
   * successor as its launch-context system-prompt addendum (the seam
   * composeLaunchContext / `--append-system-prompt-file` already own). Always
   * present: even a minimal session yields the head + continuation + self-recall.
   */
  systemPromptAddendum: string;
  /**
   * The successor's positional first prompt (kickoff), or null.
   *
   * Set to the owner's FINAL message (routed through {@link deriveLaunchPromptText})
   * precisely when that message is still OPEN — `lastOwnerMessage` present AND
   * `answered === false`. That is the P-010 contract: an unanswered owner turn is
   * the one thing a successor must CONTINUE, so it arrives as a live first prompt,
   * never as quoted tail history (a quoted copy reads as already-handled). An
   * ANSWERED owner message (a model turn already followed it) or no owner message
   * at all ⇒ null: the successor opens on the carry doc alone and its loop/AUTO
   * wake picks the work back up — re-delivering a handled message would re-trigger
   * finished work.
   */
  firstPrompt: string | null;
  /** The char budget B the addendum was held to (carryDocBudgetChars(window)). */
  budgetChars: number;
  /**
   * The P-010 open-owner-question gate. When `crossesOpenOwnerMessage` is true a
   * DELIBERATE boundary must refuse ONCE before respawning (do not abandon an open
   * owner question across the cut); a FORCED boundary never trips it (its safety
   * net is exactly `firstPrompt` above — the message is carried, not lost).
   */
  openOwnerQuestion: OpenOwnerQuestionGate;
  /** Work-item ids withdrawn from a preceding machine continuation in the tail. */
  retractedContinuationRefs?: string[];
  /**
   * Number of still-open questions asked by this session. This is deliberately
   * separate from `openOwnerQuestion.crossesOpenOwnerMessage`: the P-010 gate
   * is about an unanswered human turn in the transcript, while an open
   * `coord:ask-owner` conversation lives in the conversation ledger and is
   * otherwise invisible to the transcript-tail predicate. The compaction tool
   * reports both kinds of open owner work to its caller.
   */
  openOwnerAskCount?: number;
}

export interface BuildRespawnLaunchSpecInput {
  /** The already-assembled carry document (buildCarryDoc). */
  doc: CarryDoc;
  /** The session's EFFECTIVE window in TOKENS (min(backend n_ctx, configured
   *  limit) — P-005). The caller resolves it from the per-session model registry;
   *  the budget B derives from it (carryDocBudgetChars), keeping this pure. */
  effectiveWindowTokens: number;
  /** Render clock (testability); defaults to now. */
  now?: number;
  /** AUTO mode of the RESPAWNED session — threaded to deriveLaunchPromptText.
   *  Inert when an owner message is delivered verbatim (the note-present branch),
   *  but kept explicit for the plan-pointer wording + future callers. Default true
   *  (a respawn is unattended by construction). */
  autoMode?: boolean;
  /** The plan the successor is bound to, if any — appends the exact `plans:get`
   *  pointer to the first prompt (deriveLaunchPromptText), so a plan-bound
   *  successor never has to recover the slug from context. */
  plan?: LaunchPlanRef | null;
}

/** Live adapter inputs. The deterministic assembly remains in
 * {@link buildRespawnLaunchSpec}; this wrapper only resolves an owner through
 * the already-defined carry-document producer and fails soft for the watcher. */
export interface BuildOwnerRespawnLaunchSpecOpts
  extends Omit<BuildRespawnLaunchSpecInput, 'doc'> {
  /** Effective tool-session role, threaded into the carry document so role-
   * aware recovery text can be selected at the render boundary. */
  role?: string | null;
  /** Session/transcript/workspace inputs owned by the live watcher. A threshold
   * boundary is deliberate by default; callers can explicitly mark a forced cut. */
  buildOpts?: BuildCarryDocOpts;
  /** Test seam. */
  buildFn?: (ownerId: string, opts?: BuildCarryDocOpts) => Promise<CarryDoc>;
}

/**
 * Assemble the {@link RespawnLaunchSpec} from a built carry document. Pure and
 * deterministic — the single place the P-009/P-010/P-011 producers become the
 * concrete inputs a P-018 respawn (or a session:request-compaction bounce) needs.
 */
export function buildRespawnLaunchSpec(input: BuildRespawnLaunchSpecInput): RespawnLaunchSpec {
  const { doc, effectiveWindowTokens, plan } = input;
  const now = input.now ?? Date.now();
  const autoMode = input.autoMode ?? true;

  const budgetChars = carryDocBudgetChars(effectiveWindowTokens);
  const systemPromptAddendum = renderCarryDoc(doc, now, { budgetChars });
  const openOwnerQuestion = gateOpenOwnerQuestion(doc.continuation);
  const openOwnerAskCount = doc.asks.length;

  const firstPrompt = deriveRespawnFirstPrompt(doc, autoMode, plan);

  return {
    systemPromptAddendum,
    firstPrompt,
    budgetChars,
    openOwnerQuestion,
    openOwnerAskCount,
    retractedContinuationRefs: doc.retractedContinuationRefs ?? [],
  };
}

/**
 * Build the live successor launch spec for one coordination owner. Returns null
 * on every assembly failure so the caller can leave the current session intact
 * and retain its native/gateway safety backstops.
 */
export async function buildOwnerRespawnLaunchSpec(
  ownerId: string,
  opts: BuildOwnerRespawnLaunchSpecOpts,
): Promise<RespawnLaunchSpec | null> {
  if (!ownerId?.trim()) return null;
  try {
    const build = opts.buildFn ?? buildCarryDoc;
    const buildOpts: BuildCarryDocOpts = {
      boundaryDeliberate: true,
      ...opts.buildOpts,
    };
    if (opts.role !== undefined) buildOpts.role = opts.role;
    const doc = await build(ownerId.trim(), buildOpts);
    return buildRespawnLaunchSpec({
      doc,
      effectiveWindowTokens: opts.effectiveWindowTokens,
      now: opts.now,
      autoMode: opts.autoMode,
      plan: opts.plan,
    });
  } catch {
    return null;
  }
}

/**
 * The P-010 first-prompt rule, isolated + exported for direct testing: the owner's
 * final message becomes the successor's first prompt ONLY when it is OPEN
 * (present + unanswered). A blank owner message (never expected from a real turn,
 * but guarded so it can't fall through to deriveLaunchPromptText's empty-note
 * plan-kickoff branch), an answered message, or no owner message ⇒ null. Pure.
 */
export function deriveRespawnFirstPrompt(
  doc: CarryDoc,
  autoMode = true,
  plan?: LaunchPlanRef | null,
): string | null {
  const { continuation } = doc;
  if (!continuation.lastOwnerMessage || continuation.answered) return null;
  const ownerText = continuation.lastOwnerMessage.text.trim();
  if (ownerText.length === 0) return null;
  return deriveLaunchPromptText(ownerText, autoMode, plan ?? null);
}
