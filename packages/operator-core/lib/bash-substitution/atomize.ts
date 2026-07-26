/**
 * Split a raw shell command line into the ATOMS that a substitution pattern is
 * matched against (plan `bash-to-tool-substitution-2026-07-26`, P-004).
 *
 * WHY ATOMS AND NOT WHOLE COMMANDS: agents overwhelmingly issue compound lines
 * (`cd repo && sed -n '1,80p' file.ts`, `cat x | grep y`). Matching a pattern
 * against the whole line both over-matches (a piped `| grep` would count as a
 * code search) and under-matches (a leading `cd` hides the real verb). The
 * 2026-07-26 audit bucketed by atom for exactly this reason, and the registry's
 * `bash_pattern` column is documented as "matched per command ATOM" — so this
 * module is the shared definition of what an atom IS.
 *
 * This is a deliberate PORT of the audit's own splitter (`/tmp/bash-audit/
 * intents.py`) rather than a fresh implementation: the equivalence verdicts in
 * `pairs/` are computed against samples drawn with these exact semantics, so
 * any divergence here would silently invalidate every recorded verdict and the
 * frozen baseline counts in the registry.
 *
 * Deliberately NOT a shell parser. It does not honour quoting, so a literal
 * `;` or `|` inside a quoted string splits an atom that a real shell would keep
 * whole. That is acceptable and intentional: the consumer is a PATTERN MATCHER
 * whose worst case is a spurious non-match (fail-open — the command runs), and
 * a real parser would cost far more than the precision is worth here. If a
 * pattern ever needs quote-aware matching, that pattern is too clever for this
 * registry.
 */

/** Compound-command separators, matching the audit's `SPLIT` regex exactly. */
const SEPARATORS = /\|\||&&|\||;|\n/;

/**
 * Leading wrappers that modify HOW a command runs but not WHAT it does. The
 * verb an agent actually invoked sits behind them, so `sudo journalctl -u x`
 * must match the same pattern as `journalctl -u x`.
 */
const RUNNER_PREFIX = /^(?:sudo\s+(?:-n\s+)?|nohup\s+|timeout\s+\S+\s+|time\s+|env\s+|command\s+|exec\s+)+/;

/** Leading `FOO=bar BAZ=qux` environment assignments. */
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/**
 * Normalise ONE atom: strip runner wrappers and env assignments so the command
 * verb is at position 0. Applied repeatedly because the two forms interleave
 * (`sudo PGPASSWORD=x psql`, `PGPASSWORD=x sudo -n psql`).
 */
export function normalizeAtom(atom: string): string {
  let out = atom.trim();
  for (;;) {
    const stripped = out.replace(RUNNER_PREFIX, '').replace(ENV_PREFIX, '');
    if (stripped === out) return out;
    out = stripped;
  }
}

/**
 * Split a command line into normalised, non-empty atoms.
 *
 * @example
 *   atomize("cd /repo && sed -n '1,40p' a.ts | head -5")
 *   // => ["cd /repo", "sed -n '1,40p' a.ts", "head -5"]
 */
export function atomize(command: string): string[] {
  return command
    .split(SEPARATORS)
    .map((part) => normalizeAtom(part))
    .filter((part) => part.length > 0);
}

/**
 * The first real command word of an atom (`sed`, `psql`, `journalctl`), with
 * any leading path stripped (`/usr/bin/psql` → `psql`). Returns null for an
 * atom with no recognisable verb. Used for bucketing and for the hook's cheap
 * pre-filter, which needs a token to test before paying for an HTTP call.
 */
export function atomHead(atom: string): string | null {
  const tokens = normalizeAtom(atom).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0].split('/').pop()?.replace(/^[({`$'"]+|[)}`$'"]+$/g, '') ?? '';
  return head.length > 0 ? head : null;
}
