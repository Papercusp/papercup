/**
 * tool-sequence-promote.ts — the LOOP-CLOSING half of workstream D
 * (okf-frontmatter-adoption-2026-08-08 §D).
 *
 * The design's §10 states the problem exactly: "the existing promotion path
 * still ends at a human decision — D's job is to replace that ending with the
 * graduation engine, not to build a new front end for it." Today
 * `recipeCandidates` computes a worklist and someone has to read it. This
 * module removes the reader.
 *
 * What replaces the human is NOT an automatic code change — it is evidence plus
 * a work-item another AGENT claims. A graduated tool-sequence has cleared two
 * independent bars before anything is filed:
 *
 *   1. It is a real cross-agent pattern, not ambient telemetry and not one
 *      agent's habit (the mining floors + lift — see tool-sequence-patterns).
 *   2. It PERSISTED across consecutive windows, so it is not one busy afternoon
 *      (the graduation streak, counted by the same frontier tracker the autonomy
 *      tripwires use).
 *
 * Only then does it file. Nothing here promotes code, edits a registry, or needs
 * ratification — the act is "open a work-item describing a proven repetition",
 * which is the autonomous path the owner's no-human-gates mandate asks for.
 *
 * Idempotence is the property that makes this safe to run on a schedule: every
 * filing carries a stable `watchdogKey` derived from the sequence itself, so a
 * pattern that graduates again next week COALESCES onto the open row instead of
 * minting a duplicate. Without that, a weekly sweep over a persistent pattern is
 * a duplicate generator — and persistence is precisely what we select for, so
 * every single row it files would recur.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import {
  graduateToolSequences,
  type GraduateToolSequencesOpts,
  type PersistentToolSequenceCandidate,
} from './tool-sequence-patterns';
import type { CaptureImprovementInput, CaptureImprovementResult } from './harness/improvements/capture-core';

/** Source tag stamped on every filing, so the population is queryable later. */
export const SEQUENCE_PROMOTION_SOURCE = 'tool-sequence-graduation';

/** Kill switch (default ON — finished work never ships dark). */
export const SEQUENCE_PROMOTION_KILL_ENV = 'PAPERCUSP_TOOL_SEQUENCE_PROMOTION';

/** Cap filings per sweep, so a tuning slip cannot flood the queue. */
export const DEFAULT_MAX_FILINGS = 5;

export interface PromoteToolSequencesDeps {
  capture: (input: CaptureImprovementInput) => Promise<CaptureImprovementResult>;
  log?: (msg: string) => void;
}

export interface PromoteToolSequencesOpts extends GraduateToolSequencesOpts {
  /** Max work-items filed in one sweep (default 5). */
  maxFilings?: number;
  /** Compute candidates and render, but do not file. */
  dryRun?: boolean;
}

export interface PromoteToolSequencesResult {
  /** Candidates that cleared both bars this sweep. */
  graduated: PersistentToolSequenceCandidate[];
  /** Sequence ids actually filed (or that WOULD file under dryRun). */
  filed: string[];
  /** Sequence ids the capture path declined as duplicates — the coalesce working. */
  coalesced: string[];
  /** Mined but still accruing evidence. */
  heldForEvidence: number;
  dryRun: boolean;
  disabled: boolean;
}

/** Stable cross-sweep identity for one sequence — the coalesce key. */
export function sequenceWatchdogKey(candidate: PersistentToolSequenceCandidate): string {
  return `${SEQUENCE_PROMOTION_SOURCE}:${candidate.id}`;
}

/**
 * Render the work-item body. Deliberately leads with the EVIDENCE and states the
 * concrete act, because the reader is an agent deciding whether to claim it —
 * a body that only says "this pattern is frequent" is not actionable.
 */
export function renderSequenceFiling(c: PersistentToolSequenceCandidate): {
  title: string;
  body: string;
} {
  const title = `Repeated ${c.toolsUsed.length}-call tool dance across ${c.distinctAgents} agents: ${c.label}`;
  const body = [
    `**${c.distinctAgents} distinct agents** independently perform this exact ordered sequence, and it has persisted for **${c.windowStreak} consecutive windows** (seen in ${c.windowsSeen} of ${c.windowsExamined}).`,
    '',
    '```',
    c.toolsUsed.map((t, i) => `${i + 1}. ${t}`).join('\n'),
    '```',
    '',
    `- Occurrences: **${c.occurrences}** across ${c.bursts} separate work bursts`,
    `- Strength: **${c.strength}** (mean per-transition log10 lift; ambient traffic sits near 0)`,
    `- Agents (sample): ${c.agentSample.slice(0, 8).join(', ')}`,
    '',
    '**Why this is filed automatically.** It cleared two independent bars: it is a genuine',
    'cross-agent pattern rather than ambient telemetry or one agent\'s habit, AND it persisted',
    'across consecutive windows rather than spiking during one incident. Mined from',
    '`tool_invocations` by `tool-sequence-patterns.ts`; the persistence streak is counted by the',
    'same graduation tracker the autonomy tripwires use.',
    '',
    '**The act.** Decide whether this dance should collapse into ONE call — a new tool, a new',
    'argument on the first tool, or a batch form. Repeated identical calls in the sequence',
    '(e.g. the same verb three times) usually mean the tool should accept an array.',
    'If it should NOT collapse, resolve with the reason: that is a real answer, and it stops',
    'the pattern being re-proposed.',
    '',
    `_Source: ${SEQUENCE_PROMOTION_SOURCE} · sequence id \`${c.id}\`_`,
  ].join('\n');
  return { title, body };
}

/**
 * One promotion sweep: mine, graduate, file. Never throws — a scheduled caller
 * must not be taken down by a filing failure, so each capture is guarded and its
 * failure is logged and counted rather than propagated.
 */
export async function promoteToolSequences(
  sql: postgres.Sql,
  opts: PromoteToolSequencesOpts,
  deps: PromoteToolSequencesDeps,
): Promise<PromoteToolSequencesResult> {
  const log = deps.log ?? (() => {});
  if (process.env[SEQUENCE_PROMOTION_KILL_ENV] === 'off') {
    return { graduated: [], filed: [], coalesced: [], heldForEvidence: 0, dryRun: false, disabled: true };
  }

  const mined = await graduateToolSequences(sql, opts);
  const maxFilings = Math.max(0, opts.maxFilings ?? DEFAULT_MAX_FILINGS);
  const toFile = mined.graduated.slice(0, maxFilings);

  const filed: string[] = [];
  const coalesced: string[] = [];

  for (const c of toFile) {
    if (opts.dryRun) {
      filed.push(c.id);
      continue;
    }
    const { title, body } = renderSequenceFiling(c);
    try {
      const res = await deps.capture({
        title,
        body,
        kind: 'change',
        severity: 'minor',
        scope: opts.harnessSlug ? `harness:${opts.harnessSlug}` : undefined,
        foundDuring: SEQUENCE_PROMOTION_SOURCE,
        // Stable identity ⇒ a re-graduation coalesces instead of duplicating.
        watchdogKey: sequenceWatchdogKey(c),
        // Only an OPEN duplicate declines: if a prior filing was RESOLVED and the
        // dance is STILL being performed, that is a regression worth re-raising.
        dedupScope: 'open',
      } as CaptureImprovementInput);
      if (res?.created) filed.push(c.id);
      else coalesced.push(c.id);
    } catch (err) {
      log(`promoteToolSequences: capture failed for ${c.id} (${(err as Error)?.message ?? String(err)})`);
    }
  }

  return {
    graduated: mined.graduated,
    filed,
    coalesced,
    heldForEvidence: mined.stats.heldForEvidence,
    dryRun: !!opts.dryRun,
    disabled: false,
  };
}
