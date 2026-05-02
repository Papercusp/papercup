/**
 * Parses Operator's response stream for `<suggestion>` blocks.
 *
 * Operator emits one or more <suggestion>...</suggestion> blocks in its
 * final response. Each block contains a JSON object matching the schema
 * documented in `operator-prompt.ts`. This parser is tolerant of
 * surrounding prose and malformed blocks (skipped with a warning).
 */

export interface ParsedSuggestion {
  title: string;
  why: string;
  action: 'send_directive' | 'open' | 'draft' | 'advise';
  target_harness: string | null;
  directive_kind: 'Directive' | 'Decision' | 'Priority' | null;
  directive_subject: string;
  directive_body: string;
  auto_dispatch: boolean;
  reason: string;
}

export interface ParseResult {
  suggestions: ParsedSuggestion[];
  parseErrors: string[];
}

const SUGGESTION_RE = /<suggestion>\s*([\s\S]*?)\s*<\/suggestion>/gi;

export function parseSuggestions(text: string): ParseResult {
  const result: ParseResult = { suggestions: [], parseErrors: [] };
  for (const match of text.matchAll(SUGGESTION_RE)) {
    const raw = match[1];
    if (!raw) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      result.parseErrors.push(
        `JSON parse failed: ${err instanceof Error ? err.message : String(err)}; raw=${raw.slice(0, 80)}…`,
      );
      continue;
    }
    if (!isParsedSuggestion(json)) {
      result.parseErrors.push(
        `block did not match schema: ${JSON.stringify(json).slice(0, 120)}…`,
      );
      continue;
    }
    if (json.reason && json.reason.length < 10) {
      result.parseErrors.push(`suggestion reason too short (<10 chars); skipping`);
      continue;
    }
    result.suggestions.push(json);
  }
  return result;
}

function isParsedSuggestion(x: unknown): x is ParsedSuggestion {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.title === 'string' &&
    typeof o.why === 'string' &&
    typeof o.action === 'string' &&
    ['send_directive', 'open', 'draft', 'advise'].includes(o.action as string) &&
    (o.target_harness === null || typeof o.target_harness === 'string') &&
    (o.directive_kind === null || typeof o.directive_kind === 'string') &&
    typeof o.directive_subject === 'string' &&
    typeof o.directive_body === 'string' &&
    typeof o.auto_dispatch === 'boolean' &&
    typeof o.reason === 'string'
  );
}
