import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { papercuspPath } from './papercusp-root';

/**
 * Operator preferences storage (workspace-scoped).
 *
 * Source of truth is `<papercuspRoot>/system/operator/preferences.md` —
 * a free-form markdown notebook with provenance-tagged entries. The
 * panel renders a parsed view; the LLM gets the raw markdown appended
 * to its prompt.
 *
 * Standing approvals (§4 Phase 4e) are encoded as a specific entry
 * shape so the server-side classifier can read them without re-parsing
 * markdown. Format (single line):
 *
 *   - [OPERATOR-PROPOSED-USER-CONFIRMED-<YYYY-MM-DD>] [STANDING-APPROVE]
 *     capability=<cap>, target=<harness-slug>
 */

export interface StandingApproval {
  capability: string;
  targetHarness: string;
  confirmedAt: string; // ISO date
}

export interface OperatorPreferences {
  /** Raw preferences.md text, for prompt assembly. */
  raw: string;
  /** Structured standing approvals parsed from the markdown. */
  standingApprovals: StandingApproval[];
}

function PREFS_PATH() {
  return papercuspPath('system', 'operator', 'preferences.md');
}

const APPROVAL_RE =
  /\[OPERATOR-PROPOSED-USER-CONFIRMED-(\d{4}-\d{2}-\d{2})\]\s*\[STANDING-APPROVE\][\s\S]*?capability=([^\s,]+)[\s\S]*?target=([^\s\n]+)/g;

export function loadPreferences(): OperatorPreferences {
  const path = PREFS_PATH();
  if (!existsSync(path)) {
    return { raw: '', standingApprovals: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { raw: '', standingApprovals: [] };
  }
  return { raw, standingApprovals: parseStandingApprovals(raw) };
}

export function parseStandingApprovals(markdown: string): StandingApproval[] {
  const out: StandingApproval[] = [];
  for (const m of markdown.matchAll(APPROVAL_RE)) {
    out.push({ confirmedAt: m[1], capability: m[2], targetHarness: m[3] });
  }
  return out;
}

/** Append a provenance-tagged entry. Creates the file if needed. */
export function appendPreferenceEntry(entry: string): void {
  const path = PREFS_PATH();
  mkdirSync(dirname(path), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const headerPattern = new RegExp(`(^|\\n)## ${today}\\n`);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const trimmed = entry.trimEnd();
  if (headerPattern.test(existing)) {
    writeFileSync(path, `${existing.trimEnd()}\n${trimmed}\n`);
  } else {
    const sep = existing.trim() ? '\n\n' : '';
    writeFileSync(path, `${existing.trimEnd()}${sep}## ${today}\n${trimmed}\n`);
  }
}
