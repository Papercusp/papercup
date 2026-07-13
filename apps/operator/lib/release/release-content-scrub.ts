/**
 * Keep THIS BOX's identity out of anything we publish. (WI-4446; the TS sibling
 * of `papercusp-desktop/bin/audit-release-bundle.py`, which does the same job for
 * the installer bundle.)
 *
 * [owner 2026-07-12] "same as #2 but for personal information like my name is avi
 *  on this machine, we dont want that included in our public release builds."
 *
 * WHY THE RELEASE-HISTORY PAGE NEEDS THIS AT ALL — it was NOT obvious:
 * The page's content comes from our own Postgres, so it feels internal and safe.
 * It is not. Work-item titles and plan bodies are written BY AGENTS, ON THIS BOX,
 * and they are full of it:
 *
 *   • a work-item title quoting a command:  "Run `bash /home/<user>/.papercusp/…`"
 *   • a plan's decision log:                "D-001 [owner:<FirstName> 2026-07-11] …"
 *
 * The first generated page carried the owner's home path AND his first name,
 * straight to the beta testers the page exists for. That is precisely the leak the
 * owner asked us to prevent — arriving through the door nobody was watching,
 * because the PII gate guards the INSTALLER and this is a web page.
 *
 * ⛔ NOTHING HERE IS HARDCODED. The literals are resolved from the machine at run
 * time (unix user, home path, hostname, git identity) — writing the owner's actual
 * name into a source file to search for it would BE the leak, committed to git
 * forever. Same reasoning, same resolution, as the Python gate's identity_literals().
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

export interface IdentityLiteral {
  /** What it is — used in the redaction placeholder and in gate output. */
  kind: 'user' | 'home' | 'hostname' | 'git-name' | 'git-email';
  value: string;
}

/** Generic values that are not anybody's identity — matching them would redact
 *  half the page and teach the next person to switch the gate off. */
const GENERIC_USERS = new Set(['root', 'runner', 'build', 'ubuntu', 'user', 'admin']);
const GENERIC_HOMES = new Set(['/root', '/', '/home']);

/**
 * A SHORT literal must match as a whole word or it matches half the page.
 *
 * The owner's git user.name on this box is a 3-letter first name — the exact thing
 * he asked us to keep out. A length floor would silently make his own example the
 * one identity we could never catch. Substring-matching it instead would fire on
 * every innocent occurrence inside ordinary words. So: short literals match on a
 * word boundary, case-sensitively.
 */
export function needsWordBoundary(value: string): boolean {
  return value.length < 6 && /^[a-zA-Z0-9]+$/.test(value);
}

export function literalPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return needsWordBoundary(value)
    ? new RegExp(`\\b${escaped}\\b`, 'g')
    : new RegExp(escaped, 'gi');
}

/** This machine's identity, as literal strings. Resolved from the box, never stored. */
export function identityLiterals(): IdentityLiteral[] {
  const lits: IdentityLiteral[] = [];

  try {
    const user = os.userInfo().username;
    if (user && !GENERIC_USERS.has(user)) lits.push({ kind: 'user', value: user });
  } catch {
    /* no unix user (container) — nothing to hide */
  }

  const home = os.homedir();
  if (home && !GENERIC_HOMES.has(home)) lits.push({ kind: 'home', value: home });

  const host = os.hostname();
  if (host && !/^(runner|ci-|localhost)/.test(host)) lits.push({ kind: 'hostname', value: host });

  for (const [kind, key] of [
    ['git-name', 'user.name'],
    ['git-email', 'user.email'],
  ] as const) {
    try {
      const v = execFileSync('git', ['config', '--get', key], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (v) lits.push({ kind, value: v });
    } catch {
      /* no git identity configured */
    }
  }

  return lits;
}

const PLACEHOLDER: Record<IdentityLiteral['kind'], string> = {
  user: '<user>',
  home: '~',
  hostname: '<host>',
  'git-name': '<owner>',
  'git-email': '<email>',
};

/**
 * Redact this box's identity out of text bound for publication.
 *
 * Order matters: the HOME PATH is redacted before the USERNAME, because the home
 * path CONTAINS the username (`/home/alice` ⊃ `alice`). Redacting the username
 * first would leave `/home/<user>` — which still says "this is a linux box and
 * here is the shape of its home dir", and, worse, would make the home-path
 * literal un-matchable afterwards, so the gate downstream would report CLEAN on
 * text that had in fact been half-scrubbed. Longest literal first, always.
 */
export function scrubIdentity(text: string, literals: IdentityLiteral[]): string {
  const ordered = [...literals].sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const lit of ordered) {
    out = out.replace(literalPattern(lit.value), PLACEHOLDER[lit.kind]);
  }
  return out;
}

/**
 * The GATE. Find this box's identity in text that is about to be published.
 *
 * The scrub is the fix; this is the PROOF. They are deliberately separate: a scrub
 * that silently missed a case would be invisible, so we re-read the finished bytes
 * and look again. Gate the output, not the intent — the same rule the whole
 * release rail runs on (LABELED != PACKED).
 */
export function findIdentityLeaks(
  text: string,
  literals: IdentityLiteral[],
): Array<{ kind: IdentityLiteral['kind']; count: number }> {
  const hits: Array<{ kind: IdentityLiteral['kind']; count: number }> = [];
  for (const lit of literals) {
    const matches = text.match(literalPattern(lit.value));
    if (matches && matches.length > 0) hits.push({ kind: lit.kind, count: matches.length });
  }
  return hits;
}
