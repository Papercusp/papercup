/**
 * Canonical shape for the four-element report a GOAL holder delivers to the
 * owner. The parser is intentionally pure: reporting tools use it before a
 * write, while evidence readers use the same semantics for the bounded legacy
 * compatibility path.
 *
 * Plan: shared-agent-obligations-and-briefs-2026-09-05 (P-006, A-03/A-05).
 */

export const GOAL_OWNER_REPORT_SCHEMA_VERSION = 'goal-owner-report-v1' as const;
export const GOAL_OWNER_REPORT_FIELD = 'goalOwnerReport' as const;

export const GOAL_OWNER_REPORT_FIELDS = ['moved', 'cost', 'ownerWalled', 'killed'] as const;
export type GoalOwnerReportField = (typeof GOAL_OWNER_REPORT_FIELDS)[number];

export interface GoalOwnerReportStamp {
  schemaVersion: typeof GOAL_OWNER_REPORT_SCHEMA_VERSION;
  goalId: string;
  moved: string;
  cost: string;
  ownerWalled: string;
  killed: string;
}

export interface GoalOwnerReportParseResult {
  /** At least one report label was used as a line/section heading. */
  attempted: boolean;
  complete: boolean;
  fields: Partial<Record<GoalOwnerReportField, string>>;
  missing: GoalOwnerReportField[];
  empty: GoalOwnerReportField[];
  duplicate: GoalOwnerReportField[];
}

export type GoalOwnerReportTextInput = string | readonly string[] | readonly { text?: unknown }[] | null | undefined;

const LABEL_TO_FIELD: Readonly<Record<string, GoalOwnerReportField>> = {
  MOVED: 'moved',
  COST: 'cost',
  OWNERWALLED: 'ownerWalled',
  KILLED: 'killed',
};

/**
 * SQL readers keep a narrow compatibility arm for reports written before the
 * structured stamp existed. These patterns deliberately require a report
 * label at a line boundary AND a non-empty value; an arbitrary to-human ping,
 * or prose that merely repeats "MOVED / COST / OWNER-WALLED / KILLED", cannot
 * satisfy them. Modern writes never depend on these regexes: they carry the
 * server-authored stamp above.
 */
export const GOAL_OWNER_REPORT_LEGACY_SQL_PATTERNS: Readonly<Record<GoalOwnerReportField, string>> = Object.freeze({
  moved:
    '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?MOVED([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
  cost: '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?COST([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
  ownerWalled:
    '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?OWNER[[:space:]_-]*WALLED([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
  killed:
    '(^|\\n)[[:space:]#>*+-]*(\\*\\*|__)?KILLED([[:space:]]*[:：])?(\\*\\*|__)?[[:space:]]*(:|—|–|-)[[:space:]]*[^[:space:]\\n]',
});

function inputTexts(input: GoalOwnerReportTextInput): string[] {
  if (typeof input === 'string') return [input];
  if (!Array.isArray(input)) return [];
  return input.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    return typeof entry.text === 'string' ? [entry.text] : [];
  });
}

function normalizeLabel(label: string): GoalOwnerReportField | null {
  return LABEL_TO_FIELD[label.toUpperCase().replace(/[\s_-]+/g, '')] ?? null;
}

/** Remove presentation-only Markdown around a heading without touching value text. */
function normalizeHeadingLine(raw: string): string {
  let line = raw.trim();
  line = line.replace(/^#{1,6}[ \t]+/, '');
  line = line.replace(/^(?:[-+*]|>)[ \t]+/, '');
  line = line.replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)(.*)$/, '$1$2');
  return line.trim();
}

function reportHeading(raw: string): { field: GoalOwnerReportField; remainder: string } | null {
  const line = normalizeHeadingLine(raw);
  // A value on the heading line needs punctuation. Without that constraint,
  // ordinary prose such as "moved the build" becomes a report attempt.
  const match = line.match(/^(MOVED|COST|OWNER(?:[\s_-]+)?WALLED|KILLED)(?:[ \t]*(?::|：|—|–|-)[ \t]*(.*)|[ \t]*)$/i);
  if (!match) return null;
  const field = normalizeLabel(match[1]!);
  return field ? { field, remainder: (match[2] ?? '').trim() } : null;
}

function normalizeValue(lines: readonly string[]): string {
  return lines
    .join('\n')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Parse report headings from structured coord sections or legacy flat text.
 * Explicit "none" and "unknown (…)" are valid values: the contract requires
 * honesty, not invented activity. Duplicate headings are refused because there
 * would be no canonical field value to stamp.
 */
export function parseGoalOwnerReport(input: GoalOwnerReportTextInput): GoalOwnerReportParseResult {
  const occurrences = new Map<GoalOwnerReportField, string[]>();

  for (const text of inputTexts(input)) {
    let current: GoalOwnerReportField | null = null;
    let buffer: string[] = [];
    const flush = () => {
      if (!current) return;
      const values = occurrences.get(current) ?? [];
      values.push(normalizeValue(buffer));
      occurrences.set(current, values);
      current = null;
      buffer = [];
    };

    for (const line of text.split(/\r?\n/)) {
      const heading = reportHeading(line);
      if (heading) {
        flush();
        current = heading.field;
        buffer = heading.remainder ? [heading.remainder] : [];
      } else if (current) {
        buffer.push(line);
      }
    }
    flush();
  }

  const attempted = occurrences.size > 0;
  const fields: Partial<Record<GoalOwnerReportField, string>> = {};
  const missing: GoalOwnerReportField[] = [];
  const empty: GoalOwnerReportField[] = [];
  const duplicate: GoalOwnerReportField[] = [];
  for (const field of GOAL_OWNER_REPORT_FIELDS) {
    const values = occurrences.get(field);
    if (!values) {
      missing.push(field);
      continue;
    }
    if (values.length !== 1) duplicate.push(field);
    const value = values[0] ?? '';
    if (!value) empty.push(field);
    else fields[field] = value;
  }

  return {
    attempted,
    complete: attempted && missing.length === 0 && empty.length === 0 && duplicate.length === 0,
    fields,
    missing,
    empty,
    duplicate,
  };
}

export function stampGoalOwnerReport(goalId: string, parsed: GoalOwnerReportParseResult): GoalOwnerReportStamp {
  const id = goalId.trim();
  if (!id) throw new Error('goal owner report stamp requires a goal id');
  if (!parsed.complete) throw new Error('cannot stamp an incomplete goal owner report');
  return {
    schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
    goalId: id,
    moved: parsed.fields.moved!,
    cost: parsed.fields.cost!,
    ownerWalled: parsed.fields.ownerWalled!,
    killed: parsed.fields.killed!,
  };
}

export function isGoalOwnerReportStamp(value: unknown, goalId?: string): value is GoalOwnerReportStamp {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stamp = value as Partial<Record<keyof GoalOwnerReportStamp, unknown>>;
  if (stamp.schemaVersion !== GOAL_OWNER_REPORT_SCHEMA_VERSION) return false;
  if (typeof stamp.goalId !== 'string' || !stamp.goalId.trim()) return false;
  if (goalId !== undefined && stamp.goalId !== goalId) return false;
  return GOAL_OWNER_REPORT_FIELDS.every(
    (field) => typeof stamp[field] === 'string' && Boolean((stamp[field] as string).trim()),
  );
}

/**
 * Canonical evidence predicate for stored coord envelopes. Modern evidence is
 * the server-authored stamp. Legacy evidence must contain all four labeled
 * values AND name the exact goal in its body; this preserves the old subject
 * rule without letting a wrong-goal report clear a new window.
 */
export function envelopeHasCompleteGoalOwnerReport(envelope: unknown, goalId: string): boolean {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  const record = envelope as Record<string, unknown>;
  if (isGoalOwnerReportStamp(record[GOAL_OWNER_REPORT_FIELD], goalId)) return true;
  if (typeof record.body !== 'string' || !record.body.includes(goalId)) return false;
  return parseGoalOwnerReport(record.body).complete;
}
