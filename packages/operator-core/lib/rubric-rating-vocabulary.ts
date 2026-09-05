/**
 * Pure authoring-time validation for rubric rating instructions.
 *
 * A rubric's `ratingScale` is the vocabulary that scorecards:emit accepts. The
 * criterion procedure prose is authored separately, so it can accidentally tell a
 * grader to emit a different value (`Grade \`partial\`` on a
 * `healthy/degraded/broken/unknown` rubric). This module finds only explicit
 * grade/rating directives; ordinary prose that merely mentions a possible state
 * remains valid.
 */

export type RubricRatingInstructionField = 'method' | 'replication';

export interface RubricRatingVocabularyCriterion {
  key: string;
  method?: string;
  replication?: string;
  ratingScale?: readonly string[];
}

export interface RubricRatingInstruction {
  criterionKey: string;
  field: RubricRatingInstructionField;
  rating: string;
  /** The short authored-prose fragment containing the directive. */
  excerpt: string;
}

export interface RubricRatingVocabularyViolation extends RubricRatingInstruction {
  /** The effective scale for this criterion (criterion override or rubric default). */
  allowedRatings: string[];
}

export interface RubricRatingVocabularyValidation {
  ok: boolean;
  instructions: RubricRatingInstruction[];
  violations: RubricRatingVocabularyViolation[];
}

type ParsedDirective = {
  rating: string;
  end: number;
};

const DIRECTIVE_RE = /\b(grade|rate|rating)\b/gi;
const UNQUOTED_RATING_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*/;
const EXPLICIT_FOLLOWING_WORD_RE = /^(?:if|when|unless|because|for|where|on)\b/i;
const NON_RATING_DIRECTIVE_WORDS = new Set([
  'according',
  'around',
  'based',
  'by',
  'from',
  'limit',
  'of',
  'on',
  'relative',
  'scale',
  'the',
  'using',
  'value',
  'via',
  'with',
]);

// These are contextual objects, not score labels.  In particular, phrases such
// as "grade it on observed evidence" are instructions about the basis for a
// judgement, not requests to emit the literal rating "it".  Keeping this list
// narrow preserves the fail-closed behavior for real, unquoted labels.
const NON_RATING_TARGET_WORDS = new Set(['it', 'this', 'that', 'them', 'one', 'ones']);

function normalizeRating(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isQuote(value: string): boolean {
  return value === '`' || value === "'" || value === '"' || value === '“' || value === '‘';
}

function closingQuote(opening: string): string {
  if (opening === '“') return '”';
  if (opening === '‘') return '’';
  return opening;
}

function skipDirectiveConnector(input: string): string {
  let rest = input.trimStart();
  for (;;) {
    if (rest.startsWith(':') || rest.startsWith('=')) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    const connector = /^(?:as|is|of)\b/i.exec(rest);
    if (!connector) return rest;
    rest = rest.slice(connector[0].length).trimStart();
  }
}

/**
 * Parse the target of one `grade`/`rate`/`rating` directive.
 *
 * Unquoted prose is intentionally conservative: a single word is accepted only
 * at the end of the directive or before a condition/punctuation boundary. This
 * avoids treating "rate limit" or "grade based on evidence" as rating values.
 */
function parseDirectiveTarget(input: string, directive: string): ParsedDirective | null {
  const rest = skipDirectiveConnector(input);
  if (!rest) return null;

  const opening = rest[0];
  if (isQuote(opening)) {
    const close = closingQuote(opening);
    const end = rest.indexOf(close, 1);
    if (end <= 1) return null;
    const rating = rest.slice(1, end).trim();
    return rating ? { rating, end: input.indexOf(rest) + end + 1 } : null;
  }

  // `rating` is a noun in most prose. Require an explicit connector or quoted
  // value before interpreting its unquoted next word as a rating.
  if (directive.toLowerCase() === 'rating' && rest === input.trimStart()) {
    return null;
  }

  const token = UNQUOTED_RATING_RE.exec(rest)?.[0];
  if (!token || NON_RATING_DIRECTIVE_WORDS.has(token.toLowerCase()) || NON_RATING_TARGET_WORDS.has(token.toLowerCase())) {
    return null;
  }

  const afterToken = rest.slice(token.length).trimStart();
  const explicitBoundary =
    afterToken.length === 0 ||
    /^[,;:.!?)]/.test(afterToken) ||
    EXPLICIT_FOLLOWING_WORD_RE.test(afterToken);
  if (!explicitBoundary) return null;

  return {
    rating: token,
    end: input.indexOf(rest) + token.length,
  };
}

function excerpt(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 24);
  const to = Math.min(text.length, end + 72);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

/** Extract explicit rating instructions from one criterion procedure field. */
export function extractRubricRatingInstructions(
  criterionKey: string,
  field: RubricRatingInstructionField,
  text: string | undefined,
): RubricRatingInstruction[] {
  if (!text?.trim()) return [];

  const instructions: RubricRatingInstruction[] = [];
  for (const match of text.matchAll(DIRECTIVE_RE)) {
    const directive = match[1];
    const directiveStart = match.index ?? 0;
    // A directive embedded in a compound label (for example `GOAL+GRADE
    // mode`) is a noun/heading, not an instruction to emit `mode`.
    const preceding = text[directiveStart - 1];
    if (preceding === '+' || preceding === '-' || preceding === '/') continue;
    const target = parseDirectiveTarget(text.slice(directiveStart + match[0].length), directive);
    if (!target) continue;
    const end = directiveStart + match[0].length + target.end;
    instructions.push({
      criterionKey,
      field,
      rating: target.rating,
      excerpt: excerpt(text, directiveStart, end),
    });
  }
  return instructions;
}

function effectiveScale(
  criterion: RubricRatingVocabularyCriterion,
  rubricRatingScale: readonly string[],
): string[] {
  const scale = criterion.ratingScale ?? rubricRatingScale;
  return scale
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * Validate explicit rating instructions against each criterion's effective scale.
 *
 * The comparison matches scorecard validation: labels are case-insensitive but
 * otherwise literal. A criterion override wins over the rubric-level scale.
 */
export function validateRubricRatingVocabulary(
  criteria: ReadonlyArray<RubricRatingVocabularyCriterion>,
  rubricRatingScale: readonly string[],
): RubricRatingVocabularyValidation {
  const instructions: RubricRatingInstruction[] = [];
  const violations: RubricRatingVocabularyViolation[] = [];

  for (const criterion of criteria) {
    const criterionInstructions = [
      ...extractRubricRatingInstructions(criterion.key, 'method', criterion.method),
      ...extractRubricRatingInstructions(criterion.key, 'replication', criterion.replication),
    ];
    instructions.push(...criterionInstructions);

    const allowedRatings = effectiveScale(criterion, rubricRatingScale);
    const allowed = new Set(allowedRatings.map(normalizeRating));
    for (const instruction of criterionInstructions) {
      if (!allowed.has(normalizeRating(instruction.rating))) {
        violations.push({ ...instruction, allowedRatings });
      }
    }
  }

  return { ok: violations.length === 0, instructions, violations };
}

/**
 * Throw the authoring-time teaching error used by rubrics:propose/amend.
 *
 * This is a thin assertion over the pure result above; callers that need a
 * non-throwing report should use validateRubricRatingVocabulary directly.
 */
export function assertRubricRatingVocabulary(
  criteria: ReadonlyArray<RubricRatingVocabularyCriterion>,
  rubricRatingScale: readonly string[],
  opts: { rubricId?: string } = {},
): void {
  const validation = validateRubricRatingVocabulary(criteria, rubricRatingScale);
  if (validation.ok) return;

  const details = validation.violations
    .map(
      (violation) =>
        `criterion '${violation.criterionKey}' ${violation.field} explicitly instructs rating ` +
        `'${violation.rating}', but its effective ratingScale is ` +
        `[${violation.allowedRatings.join(' | ')}] (excerpt: ${violation.excerpt})`,
    )
    .join('; ');
  const rubricLabel = opts.rubricId ? ` '${opts.rubricId}'` : '';
  throw new Error(
    `invalid_args: proposeRubric: rubric${rubricLabel} contains off-scale rating instructions — ${details}. ` +
      'Use a value from the effective ratingScale or revise the procedure prose.',
  );
}
