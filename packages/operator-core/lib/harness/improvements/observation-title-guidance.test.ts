/**
 * observation-title-guidance.test.ts — the P-001 guard
 * (observation-and-recall-surface-honesty-2026-08-16).
 *
 * WHAT THIS PINS: that every surface which asks an agent for an observation
 * title — or for free text whose first line BECOMES one — still states the
 * identifier rule. The failure this prevents is silent: nothing breaks when one
 * surface quietly reverts to "one-line summary", and the cost only shows up
 * months later as another 99.3%-singleton corpus.
 *
 * FALSIFIABILITY (repo discipline: a guard that has never failed is untested).
 * The predicates below are exercised against deliberately-wrong controls kept
 * permanently in this file — including the VERBATIM text this change replaced —
 * so a predicate loosened until it matches anything fails here first. No
 * production file is mutated to prove it (see CLAUDE.md § proving a guard is
 * falsifiable).
 *
 * Run: npm run test:file -- packages/operator-core/lib/harness/improvements/observation-title-guidance.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONDITION_KEY_RULE,
  OBSERVATION_EVIDENCE_RULE,
  HARVESTED_COORD_NOTES_RULE,
  HARVESTED_FIRST_LINE_RULE,
  OBSERVATION_TITLE_RULE,
  OBSERVATION_TITLE_RULE_SHORT,
} from './observation-title-guidance';
import captureTool from '../../agent-tools/improvements/capture';
import loopCheckpointTool from '../../agent-tools/loop/checkpoint';
import completeTool from '../../agent-tools/work_items/complete';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/* ── the predicates ───────────────────────────────────────────────────────── */

/** Names the SHAPE rule: an identifier, explicitly not a sentence. */
function namesIdentifierNotSentence(text: string): boolean {
  return /\bidentifier\b/i.test(text) && /not a sentence/i.test(text);
}

/**
 * Names the stable SUBJECT and what counts as one. All four exemplars are
 * required: "lead with the stable subject" alone is unactionable — the whole
 * point is that an agent has to be told a file path or an error class IS one.
 */
function namesStableSubject(text: string): boolean {
  return (
    /stable subject/i.test(text) &&
    /\btool\b/i.test(text) &&
    /\bsurface\b/i.test(text) &&
    /\bfile path\b/i.test(text) &&
    /\berror class\b/i.test(text)
  );
}

/** Names WHICH line of a free-text reflection becomes the title. */
function namesFirstLineIsTheTitle(text: string): boolean {
  return /first line/i.test(text) && /\btitle\b/i.test(text);
}

/** Sends the narrative somewhere other than the title. */
function sendsNarrativeElsewhere(text: string): boolean {
  return /(narrative|story)/i.test(text) && /(body|lines below)/i.test(text);
}

/**
 * P-002. Tells the agent it may MINT a conditionKey and gives the shape.
 *
 * "Mentions conditionKey" is deliberately NOT enough: the field description
 * always mentioned it. What was missing — and what made 99.2% of agent filings
 * skip it — is that an agent may author one itself instead of copying a
 * machine-published key, so the mint permission and the `<area>:<subject>` shape
 * are both required.
 */
function invitesMintingAConditionKey(text: string): boolean {
  return (
    /conditionKey/i.test(text) &&
    /\bmint\b/i.test(text) &&
    /<area>:<stable-subject>|<area>:<subject>/i.test(text) &&
    /repeatCount/i.test(text)
  );
}

/* ── controls: text that must NOT satisfy the predicates ──────────────────── */

const CONTROLS = {
  /** VERBATIM the `improvements:capture { title }` description this change replaced. */
  theTextThisReplaced: 'one-line summary (do NOT include a [kind] prefix — pass kind separately)',
  /** VERBATIM the `loop:checkpoint { insight }` description this change replaced. */
  theInsightTextThisReplaced: 'The non-obvious thing a cold successor would waste time re-deriving.',
  /** The plausible-sounding rewrite that would reintroduce the whole defect. */
  plausibleButWrong: 'Write a clear, descriptive one-line summary of what you observed, in your own words.',
  /** Keyword soup: mentions the vocabulary without stating a rule. */
  keywordSoupNoRule: 'Observation titles are indexed. Tools, surfaces, files and error classes are all searchable.',
  /**
   * VERBATIM the echo-only framing of `conditionKey` this change replaced. It
   * mentions the field, the mechanism and repeatCount — and still produced a
   * 0.77% adoption rate, because it never says an agent may author a key.
   */
  conditionKeyAsEchoOnly:
    "EI-15448, lane:'observation' ONLY: a STABLE identity for a RECURRING condition (e.g. an OverwatchBrief " +
    "anomaly line's `[conditionKey: overwatch:escalation-aging]` — copy it verbatim). A still-OPEN prior " +
    'observation carrying the SAME conditionKey is updated in place (repeatCount bumped, title/body refreshed).',
} as const;

describe('the rule text itself states the rule (calibration + controls)', () => {
  it('OBSERVATION_TITLE_RULE names identifier-not-sentence, the stable subject, and where narrative goes', () => {
    expect(namesIdentifierNotSentence(OBSERVATION_TITLE_RULE)).toBe(true);
    expect(namesStableSubject(OBSERVATION_TITLE_RULE)).toBe(true);
    expect(sendsNarrativeElsewhere(OBSERVATION_TITLE_RULE)).toBe(true);
  });

  it('HARVESTED_FIRST_LINE_RULE names which line becomes the title, and the stable subject', () => {
    expect(namesFirstLineIsTheTitle(HARVESTED_FIRST_LINE_RULE)).toBe(true);
    expect(namesStableSubject(HARVESTED_FIRST_LINE_RULE)).toBe(true);
  });

  it('HARVESTED_COORD_NOTES_RULE names the field, the first line, and the stable subject', () => {
    expect(HARVESTED_COORD_NOTES_RULE).toContain('coordNotes');
    expect(namesFirstLineIsTheTitle(HARVESTED_COORD_NOTES_RULE)).toBe(true);
    expect(namesStableSubject(HARVESTED_COORD_NOTES_RULE)).toBe(true);
  });

  it('OBSERVATION_TITLE_RULE_SHORT still carries the rule, not just the word "title"', () => {
    expect(/\bIDENTIFIER\b/.test(OBSERVATION_TITLE_RULE_SHORT)).toBe(true);
    expect(namesStableSubject(OBSERVATION_TITLE_RULE_SHORT)).toBe(true);
  });

  it('OBSERVATION_EVIDENCE_RULE names the free-text and rubric evidence channels', () => {
    expect(OBSERVATION_EVIDENCE_RULE).toMatch(/top-level body/i);
    expect(OBSERVATION_EVIDENCE_RULE).toMatch(/observation\.evidence is not a valid field/i);
    expect(OBSERVATION_EVIDENCE_RULE).toMatch(/observation\.ratings\[criterion\]\.evidence/i);
  });

  it('the predicates REJECT the exact text this change replaced (the guard can fail)', () => {
    expect(namesIdentifierNotSentence(CONTROLS.theTextThisReplaced)).toBe(false);
    expect(namesStableSubject(CONTROLS.theTextThisReplaced)).toBe(false);
    expect(namesFirstLineIsTheTitle(CONTROLS.theInsightTextThisReplaced)).toBe(false);
    expect(namesStableSubject(CONTROLS.theInsightTextThisReplaced)).toBe(false);
  });

  it('CONDITION_KEY_RULE invites the agent to MINT a key, with a shape (P-002)', () => {
    expect(invitesMintingAConditionKey(CONDITION_KEY_RULE)).toBe(true);
  });

  it('the predicate REJECTS the echo-only conditionKey framing this change replaced', () => {
    // The control mentions conditionKey, the mechanism AND repeatCount — a looser
    // predicate ("does it mention conditionKey?") passes it, which is exactly the
    // guidance that produced 0.77% adoption.
    expect(CONTROLS.conditionKeyAsEchoOnly).toContain('conditionKey');
    expect(CONTROLS.conditionKeyAsEchoOnly).toContain('repeatCount');
    expect(invitesMintingAConditionKey(CONTROLS.conditionKeyAsEchoOnly)).toBe(false);
  });

  it('the predicates REJECT a plausible rewrite and keyword soup', () => {
    expect(namesIdentifierNotSentence(CONTROLS.plausibleButWrong)).toBe(false);
    expect(namesStableSubject(CONTROLS.plausibleButWrong)).toBe(false);
    expect(sendsNarrativeElsewhere(CONTROLS.plausibleButWrong)).toBe(false);
    expect(namesIdentifierNotSentence(CONTROLS.keywordSoupNoRule)).toBe(false);
    expect(namesStableSubject(CONTROLS.keywordSoupNoRule)).toBe(false);
  });
});

/* ── the tool surfaces ────────────────────────────────────────────────────── */

type Described = { description?: string };
type MaybeShaped = {
  shape?: Record<string, unknown>;
  /** z.preprocess wrapper: the model-facing object hangs off `out`. */
  out?: unknown;
  /** z.union wrapper. */
  options?: unknown[];
  /** z.optional / z.nullable wrapper. */
  unwrap?: () => unknown;
};

/**
 * Resolve one field's model-facing `description` from a tool's args schema,
 * walking the wrappers this repo actually uses (preprocess → pipe `out`, union
 * → `options[]`, optional/nullable → `unwrap()`).
 *
 * THROWS when the field cannot be reached. That is the point: returning `''`
 * would make a schema refactor look like a guidance regression, and — worse —
 * a `.not.toContain()` style assertion would then pass vacuously.
 */
function fieldDescription(argsSchema: unknown, field: string): string {
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): string | null => {
    if (node === null || typeof node !== 'object' || depth > 8 || seen.has(node)) return null;
    seen.add(node);
    const n = node as MaybeShaped;
    if (n.shape && Object.prototype.hasOwnProperty.call(n.shape, field)) {
      const target = n.shape[field];
      const direct = (target as Described)?.description;
      if (typeof direct === 'string' && direct.length > 0) return direct;
      // `.optional()` / `.nullable()` wrap the described schema.
      const inner = typeof (target as MaybeShaped)?.unwrap === 'function' ? (target as MaybeShaped).unwrap?.() : null;
      const innerDesc = (inner as Described | null)?.description;
      if (typeof innerDesc === 'string' && innerDesc.length > 0) return innerDesc;
    }
    if (n.out !== undefined) {
      const hit = visit(n.out, depth + 1);
      if (hit) return hit;
    }
    if (Array.isArray(n.options)) {
      for (const option of n.options) {
        const hit = visit(option, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const found = visit(argsSchema, 0);
  if (found === null) {
    throw new Error(
      `observation-title-guidance guard: could not resolve a description for field "${field}" from the args schema. ` +
        `The schema shape changed — re-point this walker rather than deleting the assertion, or the guidance ` +
        `regression this guard exists to catch becomes invisible again.`,
    );
  }
  return found;
}

describe('every surface that asks for an observation title states the rule', () => {
  it('improvements:capture { title } embeds the shared rule verbatim', () => {
    const description = fieldDescription(captureTool.args, 'title');
    expect(description).toContain(OBSERVATION_TITLE_RULE);
    expect(namesIdentifierNotSentence(description)).toBe(true);
    expect(namesStableSubject(description)).toBe(true);
    // The pre-existing contract it must not have lost.
    expect(description).toMatch(/\[kind\] prefix/i);
  });

  it('improvements:capture { observation } still points the narrative at the body', () => {
    const description = fieldDescription(captureTool.args, 'observation');
    expect(description).toContain(OBSERVATION_EVIDENCE_RULE);
    expect(description).toMatch(/identifying/i);
    expect(description).toMatch(/\bbody\b/i);
  });

  it('improvements:capture { conditionKey } offers the DESIGNED recurrence path (P-002)', () => {
    const description = fieldDescription(captureTool.args, 'conditionKey');
    expect(description).toContain(CONDITION_KEY_RULE);
    expect(invitesMintingAConditionKey(description)).toBe(true);
    // The pre-existing contract it must not have lost.
    expect(description).toMatch(/copy that one verbatim/i);
    expect(description).toMatch(/scorecard:<rubricRef>:<sourceHive>/);
    expect(description).toContain('For an ordinary improvement/bug capture');
    expect(description).toContain('exact-key coalescer');
    expect(description).not.toMatch(/Ignored outside lane:'observation'/);
  });

  it('loop:checkpoint { insight } says its FIRST LINE becomes the observation title', () => {
    const description = fieldDescription(loopCheckpointTool.args, 'insight');
    expect(description).toContain(HARVESTED_FIRST_LINE_RULE);
    expect(namesFirstLineIsTheTitle(description)).toBe(true);
    expect(namesStableSubject(description)).toBe(true);
    // The pre-existing contract it must not have lost.
    expect(description).toMatch(/cold successor/i);
  });

  it('work_items:complete { completion } says coordNotes is harvested first-line-first', () => {
    const description = fieldDescription(completeTool.args, 'completion');
    expect(description).toContain(HARVESTED_COORD_NOTES_RULE);
    expect(namesFirstLineIsTheTitle(description)).toBe(true);
    // The structured-evidence contract it must not contradict. Bare strings were
    // deliberately retired because they cannot carry verification or coverage.
    expect(description).toMatch(/bare STRING is rejected/i);
    expect(description).toMatch(/cannot carry structured evidence/i);
  });
});

/* ── the prose surfaces ───────────────────────────────────────────────────── */

const PLAYBOOKS = [
  'apps/operator/prompts/papercusp-su-engineer.tools.md',
  'apps/operator/prompts/papercusp-su-power.tools.md',
].map((relative) => resolve(repoRoot, relative));

describe('the su playbooks carry the rule where turn-end reflection is taught', () => {
  it.each(PLAYBOOKS)('%s states the identifier rule', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(namesIdentifierNotSentence(source)).toBe(true);
    expect(namesStableSubject(source)).toBe(true);
    expect(sendsNarrativeElsewhere(source)).toBe(true);
    // It must reach the HARVESTED path too, not only the explicit-title path.
    expect(source).toMatch(/loop:checkpoint \{ insight \}/);
    expect(source).toMatch(/coordNotes/);
  });

  it.each(PLAYBOOKS)('%s states the observation evidence routing', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toContain('top-level `body`');
    expect(source).toMatch(/`observation\.evidence` is not a valid field/i);
    expect(source).toContain('`observation.ratings[criterion].evidence`');
  });

  it.each(PLAYBOOKS)('%s teaches conditionKey as something to MINT (P-002)', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(invitesMintingAConditionKey(source)).toBe(true);
  });

  /**
   * PLAN D-002 — the fix is never "file fewer observations".
   *
   * This is the regression with real cost: an agent reading "make your titles
   * better" as "only file titles worth making better" collapses the volume that
   * recurrence detection divides by, and no single agent can tell whether its
   * own friction is idiosyncratic or fleet-wide. The guidance must therefore say
   * so out loud, next to the rule — asserted positively, because "does not
   * discourage filing" is unfalsifiable as a negative.
   */
  it.each(PLAYBOOKS)('%s explicitly preserves the filing RATE (D-002)', (path) => {
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(/keep filing at the same rate/i);
    expect(source).toMatch(/volume is the denominator/i);
  });
});

/* ── the harvest site ─────────────────────────────────────────────────────── */

describe('checkpoint-harvest records why it cannot fix this itself', () => {
  const harvestSource = readFileSync(resolve(repoRoot, 'packages/operator-core/lib/harness/improvements/checkpoint-harvest.ts'), 'utf8');

  it('states that the harvested first line IS the identifier', () => {
    expect(harvestSource).toMatch(/FIRST LINE IS AN IDENTIFIER/);
  });

  it('points at the upstream guidance rather than inviting a rewrite at this seam', () => {
    expect(harvestSource).toContain('HARVESTED_FIRST_LINE_RULE');
    expect(harvestSource).toMatch(/D-002/);
  });
});
