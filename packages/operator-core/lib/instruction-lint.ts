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

function semanticFileLockMode(line: string): string | null {
  const plain = line
    .replace(/[`*_>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (
    /file-lock enforcement is not automatic/.test(plain) ||
    /nothing claims locks for you/.test(plain) ||
    /treat every edit as needing the explicit claim/.test(plain)
  ) {
    return 'explicit-manual';
  }
  if (
    /file-lock enforcement is automatic here/.test(plain) ||
    /managed hooks claim\/release file locks automatically/.test(plain)
  ) {
    return 'automatic-hooks';
  }
  return null;
}

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
  const markerCount = occurrences.length;
  // EI-11408: the original Codex contradiction was prose on one side and a
  // generated marker on the other, so marker-only lint declared it clean.
  // Recognize only the narrow, load-bearing lock modal phrases. A marker on
  // the same/adjacent line already carries that rule and suppresses a duplicate.
  lines.forEach((line, index) => {
    const value = semanticFileLockMode(line);
    if (!value) return;
    const lineNo = index + 1;
    if (
      occurrences.some(
        (entry) => entry.key === 'file-locking' && entry.value === value && Math.abs(entry.line - lineNo) <= 1,
      )
    ) {
      return;
    }
    occurrences.push({ key: 'file-locking', value, line: lineNo });
  });
  occurrences.sort((a, b) => a.line - b.line || a.key.localeCompare(b.key));

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
    markerCount,
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

/** Conflicts that make a compiled prompt unsafe to launch, rather than merely noisy. */
export function blockingInstructionConflicts(report: InstructionLintReport) {
  return report.conflicts.filter((conflict) => conflict.key === 'file-locking');
}
