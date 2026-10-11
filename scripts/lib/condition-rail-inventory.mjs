/**
 * condition-rail-inventory.mjs — the MEASURING inventory of failure/degradation signals that
 * bypass the condition rail. Plan `degradation-signals-on-condition-rail-2026-10-11`, P-001
 * (BAR R-4); the P-006 lint (BAR R-6) is built on this same scanner.
 *
 * ── WHAT "THE RAIL" IS ───────────────────────────────────────────────────────────────────────
 * A signal is ON the rail when it raises a durable, keyed condition that the condition bridge
 * turns into an owned work item and later resolves: `broadcastSevereEvent({ conditionKey })` /
 * `broadcastSevereEventResolved`, or the generic `observeFallback` primitive (P-002) whose
 * watchdog (P-003) does that for it. Everything else that notices a failure — a desktop
 * notification, a log line, a boolean on a health payload, a private watchdog loop — is seen by
 * a human only if one happens to be looking. That gap is what let the 2026-10-11 gate reuse
 * collapse (0 of ~7,689 files reused) go unalarmed.
 *
 * ── THE FIVE CLASSES (R-4) ───────────────────────────────────────────────────────────────────
 *   owner-only-alarm          notifyAttention / notifyAttentionOnce / escalateAlarm call with no
 *                             conditionKey or severe-event broadcast beside it. Neither API takes
 *                             a conditionKey, so such a call can only page the owner.
 *   log-only-fallback         a log call whose message says the code is falling back / failing
 *                             open / degrading, with no rail call beside it.
 *   health-flag-no-condition  an alarm-shaped health field (alarm, alert, degraded, unhealthy,
 *                             breached, …) set to a VALUE in a health/watchdog/alarm/monitor file
 *                             that never raises a condition.
 *   bespoke-watchdog          a watchdog module (or a `managedSetInterval('…watchdog…')`) that
 *                             never raises a condition.
 *   signal-waiver             a `waiver:` on a signal-actor-registry entry — an accepted-risk
 *                             signal with no acting consumer.
 *
 * ── HOW IT MEASURES ──────────────────────────────────────────────────────────────────────────
 * Every token is matched in LIVE CODE only: the source is passed through
 * `stripCommentsAndStrings` (length-preserving), so a pattern quoted in a comment, a doc string
 * or a test fixture literal is not a site. Message wording (class 2) and interval names
 * (class 4) live INSIDE strings by nature, so those are read from the raw text — but only at a
 * call whose anchor is live code. "Beside it" means within RAIL_WINDOW_LINES lines of the site,
 * matched in live code.
 *
 * Rows are grouped into dispositions by `class|file` (see condition-rail-dispositions.mjs): a
 * site's disposition is the most specific entry among `class|file|symbol` and `class|file`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsAndStrings } from './strip-comments-and-strings.mjs';

export const CLASSES = Object.freeze([
  'owner-only-alarm',
  'log-only-fallback',
  'health-flag-no-condition',
  'bespoke-watchdog',
  'signal-waiver',
]);

/** Lines on either side of a site searched for a rail call. */
export const RAIL_WINDOW_LINES = 40;

/** Directories scanned. Generated bundles, tests and retired code are excluded by isScannable. */
export const SCAN_ROOTS = Object.freeze(['packages/', 'apps/', 'orchestrator/', 'bin/', 'scripts/', 'libs/']);

const CODE_EXT_RE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;

/** Is this tracked path a source file the inventory should read? Pure. */
export function isScannable(file) {
  if (!SCAN_ROOTS.some((r) => file.startsWith(r))) return false;
  if (!CODE_EXT_RE.test(file) || file.endsWith('.d.ts') || file.endsWith('.d.mts')) return false;
  if (/(^|\/)(node_modules|_retired|__fixtures__|fixtures|coverage)\//.test(file)) return false;
  if (/(^|\/)dist[^/]*\//.test(file) || /(^|\/)\.vitest-tmp\//.test(file)) return false;
  if (/(^|\/)__tests__\//.test(file) || /\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/(^|\/)(sidecar|target|build|out|public|vendor|storybook-static)\//.test(file)) return false; // bundles / vendored assets
  // This scanner and its dispositions name every token on purpose.
  if (/scripts\/lib\/condition-rail-(inventory|dispositions)\.mjs$/.test(file)) return false;
  return true;
}

// ── Live-code token patterns (matched against the MASKED text) ────────────────────────────────
// The rail functions match as IDENTIFIERS, not only as calls: a module that injects the rail
// (`const broadcast = deps.broadcast ?? broadcastSevereEvent`) raises conditions through the alias.
const RAIL_RE = /\bconditionKeys?\b|\bbroadcastSevereEvent(?:Resolved)?\b|\bobserveFallback\b/;
const ALARM_CALL_RE = /\b(notifyAttention|notifyAttentionOnce|escalateAlarm)\s*\(/g;
const LOG_CALL_RE = /\b(?:console\.(?:warn|error|log|info)|(?:log|logger|LOG)\.(?:warn|error|info))\s*\(/g;
const FALLBACK_WORDING_RE = /fall(?:ing|s)?[ -]?back|fail(?:ing|s)?[ -]?open|fail(?:ed|ing)? open|degrad(?:ed|ing) to/i;
const HEALTH_FIELD_RE = /\b(alarm|alarming|alert|alerting|degraded|unhealthy|breached)\s*:\s*([^,;\n}]+)/g;
const HEALTH_PATH_RE = /(health|watchdog|alarm|monitor)/i;
const TYPE_ONLY_VALUE_RE = /^(?:boolean|string|number|null|undefined|unknown|true\s*\|\s*false|[A-Z]\w*(?:\[\])?)\s*$/;
const INTERVAL_RE = /\bmanagedSetInterval\s*\(/g;
const DEFINE_SIGNAL_RE = /\bdefineSignal\s*\(/;
const WAIVER_RE = /\bwaiver\s*:\s*\{/g;
const SIGNAL_ID_RE = /\bid\s*:\s*['"`]([^'"`]+)['"`]/g;

/** Cheap raw pre-filter: a file with none of these tokens cannot hold a site. */
const PREFILTER_RE =
  /notifyAttention|escalateAlarm|fall(?:ing|s)?[ -]?back|fail(?:ing|s|ed)?[ -]?open|degrad|alarm|alert|unhealthy|breached|watchdog|waiver/i;

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

function windowText(masked, starts, line, radius) {
  const from = starts[Math.max(0, line - 1 - radius)] ?? 0;
  const toLine = Math.min(starts.length - 1, line - 1 + radius + 1);
  const to = toLine >= starts.length - 1 ? masked.length : starts[toLine];
  return masked.slice(from, to);
}

/** The raw argument text of a call starting at `openParen`, bounded to `max` chars. */
function callArgsRaw(raw, openParen, max = 400) {
  let depth = 0;
  for (let i = openParen; i < raw.length && i < openParen + max; i++) {
    const ch = raw[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return raw.slice(openParen + 1, i);
    }
  }
  return raw.slice(openParen + 1, Math.min(raw.length, openParen + max));
}

function nearestSignalId(raw, masked, index) {
  let id = null;
  SIGNAL_ID_RE.lastIndex = 0;
  // The id literal is a string (blanked in masked); its KEY is live code. Take the last id
  // whose key is live and precedes the waiver, i.e. the entry the waiver belongs to.
  for (let m; (m = SIGNAL_ID_RE.exec(raw)) && m.index < index; ) {
    if (raw[m.index] === masked[m.index]) id = m[1];
  }
  return id;
}

/**
 * Scan ONE source text. Pure: (raw, file) → rows. `file` is the repo-relative path; it selects
 * the parser kind and drives the path-scoped classes (health fields, watchdog modules).
 *
 * @param {string} raw
 * @param {string} file
 * @returns {Array<{ class: string, file: string, line: number, symbol: string, key: string }>}
 */
export function scanSource(raw, file) {
  // A watchdog MODULE is a site by its name alone, so the content pre-filter cannot skip it.
  if (!PREFILTER_RE.test(raw) && !/watchdog/i.test(file.slice(file.lastIndexOf('/') + 1))) return [];
  const masked = stripCommentsAndStrings(raw, file);
  const starts = lineStarts(masked);
  const fileOnRail = RAIL_RE.test(masked);
  const rows = [];
  const push = (cls, index, symbol) => {
    const line = lineOf(starts, index);
    rows.push({ class: cls, file, line, symbol, key: `${cls}|${file}` });
  };
  const railNear = (index) => RAIL_RE.test(windowText(masked, starts, lineOf(starts, index), RAIL_WINDOW_LINES));

  // 1. owner-only alarms
  ALARM_CALL_RE.lastIndex = 0;
  for (let m; (m = ALARM_CALL_RE.exec(masked)); ) {
    const before = masked.slice(Math.max(0, m.index - 24), m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue; // the declaration, not a call
    if (railNear(m.index)) continue;
    push('owner-only-alarm', m.index, m[1]);
  }

  // 2. log-only fallback decisions
  LOG_CALL_RE.lastIndex = 0;
  for (let m; (m = LOG_CALL_RE.exec(masked)); ) {
    const open = m.index + m[0].length - 1;
    const args = callArgsRaw(raw, open);
    if (!FALLBACK_WORDING_RE.test(args)) continue;
    if (railNear(m.index)) continue;
    const word = args.match(FALLBACK_WORDING_RE)[0].toLowerCase().replace(/\s+/g, '-');
    push('log-only-fallback', m.index, word);
  }

  // 3. health fields carrying alarm flags with no condition
  if (HEALTH_PATH_RE.test(file) && !fileOnRail) {
    HEALTH_FIELD_RE.lastIndex = 0;
    for (let m; (m = HEALTH_FIELD_RE.exec(masked)); ) {
      const prev = masked[m.index - 1];
      if (prev === '.' || prev === '?') continue; // obj.alarm ? a : b  /  a?.alarm
      if (masked.slice(m.index + m[1].length).match(/^\s*\?\s*:/)) continue; // optional type member
      const value = m[2].trim();
      if (!value || TYPE_ONLY_VALUE_RE.test(value)) continue; // interface member / type annotation
      push('health-flag-no-condition', m.index, m[1]);
    }
  }

  // 4. bespoke watchdogs
  const base = file.slice(file.lastIndexOf('/') + 1);
  if (/watchdog/i.test(base) && !fileOnRail) {
    push('bespoke-watchdog', 0, base.replace(CODE_EXT_RE, ''));
  } else if (!fileOnRail) {
    INTERVAL_RE.lastIndex = 0;
    for (let m; (m = INTERVAL_RE.exec(masked)); ) {
      const args = callArgsRaw(raw, m.index + m[0].length - 1, 200);
      const name = args.match(/^\s*['"`]([^'"`]*watchdog[^'"`]*)['"`]/i);
      if (name) push('bespoke-watchdog', m.index, name[1]);
    }
  }

  // 5. signal-actor-registry waivers
  if (DEFINE_SIGNAL_RE.test(masked)) {
    WAIVER_RE.lastIndex = 0;
    for (let m; (m = WAIVER_RE.exec(masked)); ) {
      push('signal-waiver', m.index, nearestSignalId(raw, masked, m.index) ?? 'unknown-signal');
    }
  }

  return rows;
}

/**
 * Resolve one row's disposition from a dispositions map. Most specific key wins:
 * `class|file|symbol`, then `class|file`. Returns null when the site is undispositioned.
 */
export function dispositionFor(row, dispositions) {
  return dispositions[`${row.key}|${row.symbol}`] ?? dispositions[row.key] ?? null;
}

/** Is a disposition entry well-formed? migrate needs a P-NNN item; not-applicable a reason. */
export function dispositionProblem(d) {
  if (!d || typeof d !== 'object') return 'missing';
  if (d.disposition === 'migrate') return /^P-\d{3,}$/.test(d.item ?? '') ? null : 'migrate without a P-NNN item';
  if (d.disposition === 'not-applicable') {
    return typeof d.reason === 'string' && d.reason.trim().length >= 20 ? null : 'not-applicable without a reason (>=20 chars)';
  }
  return `unknown disposition ${JSON.stringify(d.disposition)}`;
}

/**
 * Inventory a set of repo-relative files under `root`. `readFile` is injectable for tests.
 * Returns every row with its resolved disposition, plus coverage counters.
 */
export function inventory({ root, files, dispositions = {}, readFile }) {
  const read = readFile ?? ((f) => readFileSync(join(root, f), 'utf8'));
  const rows = [];
  let scanned = 0;
  let unreadable = 0;
  for (const f of files) {
    if (!isScannable(f)) continue;
    let text;
    try {
      text = read(f);
    } catch {
      unreadable++;
      continue;
    }
    scanned++;
    for (const row of scanSource(text, f)) {
      const d = dispositionFor(row, dispositions);
      rows.push({ ...row, disposition: d, problem: dispositionProblem(d) });
    }
  }
  rows.sort((a, b) => a.class.localeCompare(b.class) || a.file.localeCompare(b.file) || a.line - b.line);
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, rows.filter((r) => r.class === c).length]));
  const undispositioned = rows.filter((r) => r.problem).length;
  // A disposition key that no longer matches any site is dead weight (fixed or renamed): report it.
  const liveKeys = new Set(rows.flatMap((r) => [r.key, `${r.key}|${r.symbol}`]));
  const staleDispositions = Object.keys(dispositions).filter((k) => !liveKeys.has(k));
  return { rows, scanned, unreadable, byClass, undispositioned, staleDispositions };
}
