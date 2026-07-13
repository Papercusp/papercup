/**
 * Deterministic lint for the FINAL instruction text handed to an agent.
 *
 * Generated operating briefs stamp load-bearing rules as
 * `<!-- papercusp-rule:<key>=<value> -->`. Markers let the compiler detect real
 * contradictions without guessing policy from arbitrary prose. Exact repeated
 * normative lines are reported separately as compaction candidates.
 */

export interface InstructionRuleOccurrence {
  key: string;
  value: string;
  line: number;
}

export interface InstructionLintReport {
  markerCount: number;
  duplicateRules: Array<{ key: string; value: string; lines: number[] }>;
  conflicts: Array<{ key: string; values: string[]; lines: number[] }>;
  staleRules: Array<{ key: string; value: string; line: number; replacement: string }>;
  duplicateDirectives: Array<{ directive: string; lines: number[] }>;
  clean: boolean;
}

const RULE_RE = /<!--\s*papercusp-rule:([a-z0-9-]+)=([a-z0-9-]+)\s*-->/gi;

/** Retired mechanisms whose replacements are now canonical. */
const STALE_RULE_VALUES: Record<string, Record<string, string>> = {
  'harness-scope': { 'session-auto': 'explicit-per-call' },
  'test-router': { 'raw-vitest': 'test-file' },
  'file-locking': { advisory: 'automatic-hooks' },
  'git-ownership': { agent: 'background-sync' },
  'app-runtime': { browser: 'tauri' },
};

function normalizedDirective(line: string): string | null {
  const plain = line
    .replace(/<!--.*?-->/g, '')
    .replace(/[`*_>#|]/g, ' ')
    .replace(/^\s*[-+\d.)]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (plain.length < 24 || plain.length > 500) return null;
  if (!/\b(must|must not|never|always|do not|don't|required|only)\b/.test(plain)) return null;
  return plain.replace(/[.!:;]+$/g, '');
}

export function lintInstructionText(text: string, maxFindings = 20): InstructionLintReport {
  const lines = text.split(/\r?\n/);
  const occurrences: InstructionRuleOccurrence[] = [];
  lines.forEach((line, index) => {
    RULE_RE.lastIndex = 0;
    for (let match = RULE_RE.exec(line); match; match = RULE_RE.exec(line)) {
      occurrences.push({ key: match[1]!, value: match[2]!, line: index + 1 });
    }
  });

  const byKey = new Map<string, InstructionRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = byKey.get(occurrence.key) ?? [];
    group.push(occurrence);
    byKey.set(occurrence.key, group);
  }

  const duplicateRules: InstructionLintReport['duplicateRules'] = [];
  const conflicts: InstructionLintReport['conflicts'] = [];
  const staleRules: InstructionLintReport['staleRules'] = [];
  for (const [key, group] of byKey) {
    const values = [...new Set(group.map((entry) => entry.value))];
    if (values.length > 1) {
      conflicts.push({ key, values, lines: group.map((entry) => entry.line) });
    }
    for (const value of values) {
      const same = group.filter((entry) => entry.value === value);
      if (same.length > 1) {
        duplicateRules.push({ key, value, lines: same.map((entry) => entry.line) });
      }
      const replacement = STALE_RULE_VALUES[key]?.[value];
      if (replacement) {
        staleRules.push(...same.map((entry) => ({ key, value, line: entry.line, replacement })));
      }
    }
  }

  const directiveLines = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const directive = normalizedDirective(line);
    if (!directive) return;
    const positions = directiveLines.get(directive) ?? [];
    positions.push(index + 1);
    directiveLines.set(directive, positions);
  });
  const duplicateDirectives = [...directiveLines.entries()]
    .filter(([, positions]) => positions.length > 1)
    .map(([directive, positions]) => ({ directive, lines: positions }))
    .slice(0, maxFindings);

  return {
    markerCount: occurrences.length,
    duplicateRules: duplicateRules.slice(0, maxFindings),
    conflicts: conflicts.slice(0, maxFindings),
    staleRules: staleRules.slice(0, maxFindings),
    duplicateDirectives,
    clean:
      duplicateRules.length === 0 &&
      conflicts.length === 0 &&
      staleRules.length === 0 &&
      duplicateDirectives.length === 0,
  };
}
