/**
 * sentinel-deep-delegate — the deep-thinking delegation lane
 * (voice-unified-sentinel-pipeline-2026-07-01, P-005/P-006, D-003).
 *
 * The Sentinel pane is the ONE conversational brain, but it must stay
 * conversationally responsive — it cannot disappear into a ten-minute analysis
 * while the Herald voice goes dead. HARD THINKING (analysis / research /
 * comparison where the user expects an ANSWER back in the conversation) is
 * therefore delegated to an EPHEMERAL background su agent, one per question:
 *
 *   sentinel calls voice:delegate_deep → THIS module mints a durable claimed
 *   `task` work_item (tagged `deep-delegation`) + spawns the background
 *   agent with the question as its brief → the agent answers by COMPLETING the
 *   item (its completion.summary IS the answer) → the settled-events seam fires
 *   sentinel-deep-watch, which injects `[deep-answer WI-NNN] …` back into the
 *   pane — so the answer is spoken + written through the same one pipeline.
 *
 * Split of lanes (D-003): WORK ("build X") still goes to the Queen via
 * <handoff_to_queen> (operator-sentinel-handoff.ts) — she PLACES it. THINKING
 * goes here — the user gets the answer back in conversation. The Queen was the
 * wrong tool for cognition: her wake loop is cadenced and placement-shaped.
 *
 * The durable record is a `task` (WI-2874: the old feature-family `research-task`
 * kind was merged into `task` — research/analysis is non-code work), tagged
 * `deep_delegation`, making the delegation visible on the normal work surface.
 * To avoid a create→claim race against the frontier, it lands already
 * claimed by the background spawn id in the SAME write; if the launch is refused
 * before the nursery takes over, the claim is released back to `todo`. THE TOOL
 * SPAWNS, NOT THE SENTINEL — the sentinel's own capability envelope still denies
 * cup:spawn (the SN-H04 no-spawn contract); this module is the accountable,
 * capped indirection.
 *
 * Dependency-injected so the core unit-tests without PG/spawn machinery; the
 * real substrate wiring lives in sentinel-deep-delegate-deps.ts.
 */
import { randomUUID } from 'node:crypto';

/** Topic tag stamped on every deep-delegation work_item — the landing gate
 *  (sentinel-deep-watch) and the sentinel's own "how's it going" reads key on it. */
export const DEEP_DELEGATION_LABEL = 'deep-delegation';

/** Max concurrently-open delegations (D-003): bounds spend + keeps answers timely. */
export const DEEP_MAX_CONCURRENT = 2;
/** Bound one deep-analysis child so it cannot squat a deep slot indefinitely. */
export const DEEP_TIMEOUT_MS = 15 * 60_000;

/** Clamp for the work_item title (the question, headline-sized). */
const TITLE_MAX = 180;

export interface DeepDelegateInput {
  /** The user's question, as spoken/typed. */
  question: string;
  /** Optional extra context the sentinel wants to hand along (conversation excerpt). */
  brief?: string | null;
  /** Harness the background agent spawns into (defaults resolved by the deps). */
  harness?: string | null;
  workspaceId: string;
}

export interface DeepDelegateDeps {
  /** How many deep-delegation items are currently OPEN (non-terminal). */
  countOpenDelegations(workspaceId: string): Promise<number>;
  /** Mint the durable claimed work_item (kind `task`, tagged DEEP_DELEGATION_LABEL). */
  createWorkItem(input: {
    assignee: string;
    title: string;
    summary: string;
    harness: string | null;
    workspaceId: string;
  }): Promise<{ id: string; harness: string } | null>;
  /** Spawn the ephemeral background agent, already owning the claimed item. */
  spawn(input: {
    spawnId: string;
    workItemId: string;
    harness: string;
    brief: string;
    timeoutMs: number;
  }): Promise<{ ok: boolean; spawnId?: string | null; error?: string }>;
  log?(msg: string): void;
}

export type DeepDelegateResult =
  | {
      ok: true;
      workItemId: string;
      /** null when the spawn failed — the item stays in the backlog as the fallback. */
      spawnId: string | null;
      spawned: boolean;
    }
  | { ok: false; error: string };

/** The brief handed to the ephemeral agent. The answer-shape contract matters:
 *  completion.summary is delivered VERBATIM into the conversation (and spoken),
 *  so it must lead with the speakable answer, not process narration. */
export function buildDeepBrief(workItemId: string, question: string, extra?: string | null): string {
  return [
    `You are an EPHEMERAL deep-analysis agent. You exist to answer ONE question, then exit.`,
    ``,
    `QUESTION: ${question}`,
    ...(extra?.trim() ? [``, `CONTEXT FROM THE CONVERSATION:`, extra.trim()] : []),
    ``,
    `Rules:`,
    `- Work ONLY this question. Do not pick up other work, claim other items, or spawn agents.`,
    `- Investigate properly (read code/state/docs as needed) — you were delegated to because this needs real thought.`,
    `- Deliver the answer by completing your work item:`,
    `  work_items:complete { id: '${workItemId}', state: 'resolved', completion: { status: 'done', summary: <THE ANSWER> } }`,
    `- completion.summary IS the answer the user hears: lead with 1-3 direct, speakable sentences,`,
    `  then supporting detail. No process narration, no "I investigated…" preamble.`,
    `- If you genuinely cannot answer, complete with state 'resolved' and a summary saying what`,
    `  you found and what is missing — silence is the only failure.`,
  ].join('\n');
}

function newDeepSpawnId(): string {
  return `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export async function delegateDeep(
  input: DeepDelegateInput,
  deps: DeepDelegateDeps,
): Promise<DeepDelegateResult> {
  const question = input.question.trim();
  if (!question) return { ok: false, error: 'empty question' };

  const open = await deps.countOpenDelegations(input.workspaceId).catch(() => 0);
  if (open >= DEEP_MAX_CONCURRENT) {
    return {
      ok: false,
      error: `at capacity: ${open} deep dives already in flight (max ${DEEP_MAX_CONCURRENT}) — answer when one lands, or ask the user to wait`,
    };
  }

  const title = question.length > TITLE_MAX ? `${question.slice(0, TITLE_MAX - 1)}…` : question;
  const spawnId = newDeepSpawnId();
  const wi = await deps.createWorkItem({
    assignee: spawnId,
    title: `Deep dive: ${title}`,
    summary: buildDeepBrief('<pending>', question, input.brief),
    harness: input.harness ?? null,
    workspaceId: input.workspaceId,
  });
  if (!wi) return { ok: false, error: 'work_item create failed' };

  const spawn = await deps
    .spawn({
      spawnId,
      workItemId: wi.id,
      harness: wi.harness,
      brief: buildDeepBrief(wi.id, question, input.brief),
      timeoutMs: DEEP_TIMEOUT_MS,
    })
    .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? String(err) }));
  if (!spawn.ok) {
    // The durable item survives the spawn miss — it stays visible in the backlog
    // (the Queen's survey sees settled/open issue items), so the ask isn't lost.
    deps.log?.(`deep-delegate spawn failed for ${wi.id}: ${spawn.error ?? 'unknown'}`);
    return { ok: true, workItemId: wi.id, spawnId: null, spawned: false };
  }
  return { ok: true, workItemId: wi.id, spawnId: spawn.spawnId ?? null, spawned: true };
}
