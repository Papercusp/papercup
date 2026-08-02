/**
 * Split a raw shell command line into the COMMAND ATOMS that a substitution
 * pattern is matched against, and that every substitution percentage is
 * denominated in (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-001;
 * originally `bash-to-tool-substitution-2026-07-26`, P-004).
 *
 * WHY ATOMS AND NOT WHOLE COMMANDS: agents overwhelmingly issue compound lines
 * (`cd repo && sed -n '1,80p' file.ts`, `cat x | grep y`). Matching a pattern
 * against the whole line both over-matches (a piped `| grep` would count as a
 * code search) and under-matches (a leading `cd` hides the real verb). The
 * 2026-07-26 audit bucketed by atom for exactly this reason, and the registry's
 * `bash_pattern` column is documented as "matched per command ATOM" — so this
 * module is the shared definition of what an atom IS.
 *
 * WHY IT IS QUOTE- AND HEREDOC-AWARE, WHICH IT ORIGINALLY WAS NOT. The first
 * implementation split on a bare regex (`||`, `&&`, `|`, `;`, `\n`) and
 * documented the quote-blindness as acceptable, on the ground that the consumer
 * is a pattern matcher whose worst case is a spurious NON-match (fail-open).
 * That reasoning is sound for MATCHING and wrong for COUNTING, and this module
 * serves both. Splitting on every newline turned the body of a heredoc, an
 * inlined `node -e` script and any captured output into "atoms": `const`,
 * `import`, `return`, `do`, `done`, `Tests`, `FAIL`. Measured over the 14d
 * corpus, that inflated the denominator by 34% — 214,400 atoms reported where
 * 141,696 are commands — and a third of the population the substitution
 * programme was trying to move was therefore never substitutable, because it was
 * never a command. That is the mechanism behind the predecessor plan's headline
 * number refusing to move.
 *
 * The rule this module now implements is the one that statement implies: an atom
 * is a command only if it is in COMMAND POSITION. A separator inside a quote is
 * data, a heredoc body is data, a continued line is one line, and a shell
 * reserved word is syntax.
 *
 * Still deliberately NOT a full shell parser — no expansion, no command
 * substitution, no arithmetic context. Those cost far more than the precision is
 * worth, and their failure mode remains a spurious non-match. What changed is
 * only that the failure mode of the QUOTING bug was a spurious MATCH plus an
 * inflated denominator, and neither is acceptable.
 */

/**
 * Leading wrappers that modify HOW a command runs but not WHAT it does. The
 * verb an agent actually invoked sits behind them, so `sudo journalctl -u x`
 * must match the same pattern as `journalctl -u x`.
 */
const RUNNER_PREFIX = /^(?:sudo\s+(?:-n\s+)?|nohup\s+|timeout\s+\S+\s+|time\s+|env\s+|command\s+|exec\s+)+/;

/** Leading `FOO=bar BAZ=qux` environment assignments. */
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;

/**
 * Shell reserved words that are followed by a COMMAND, so the real verb sits
 * behind them exactly as it sits behind `sudo`. `for` and `case` are absent on
 * purpose: what follows those is a variable and a word list, not a command, so
 * they are handled by {@link isShellSyntaxAtom} instead.
 *
 * Each alternative requires trailing whitespace, so a command whose name merely
 * starts with a reserved word (`docker`, `until-tool`) is untouched.
 */
const KEYWORD_PREFIX = /^(?:!\s+|\{\s+|(?:if|elif|then|else|do|while|until)\s+)+/;

/**
 * Reserved words that can never introduce a command: either pure closing syntax
 * (`done`, `fi`, `esac`, `}`) or a compound header whose remainder is a word
 * list rather than a command (`for`, `case`, `in`, `select`). An atom headed by
 * one of these is syntax the splitter surfaced, not something an agent ran.
 *
 * The prefix words appear here too, for the case where one is left ALONE by the
 * splitter (`... ; do ; ...`): `KEYWORD_PREFIX` only strips a word that has a
 * command after it.
 */
const SYNTAX_HEADS = new Set([
  'for', 'case', 'in', 'select',
  'done', 'fi', 'esac',
  'if', 'elif', 'then', 'else', 'do', 'while', 'until',
  '\\',
]);

/**
 * A heredoc introducer: `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`.
 *
 * Anchored at the `<<` the scanner already matched. A here-STRING (`<<<`) does
 * not match — after `<<` the delimiter must be a word character, and `<` is not
 * — which is correct, because a here-string's operand is on the same line and
 * needs no body absorption.
 */
const HEREDOC_INTRODUCER = /^<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/;

/** A heredoc whose body has been introduced but not yet consumed. */
interface PendingHeredoc {
  terminator: string;
  /** `<<-` strips leading TABS from the terminator line (POSIX). */
  stripTabs: boolean;
}

/**
 * Join `\`-newline line continuations into a single logical line.
 *
 * Done before scanning because a continuation is not a separator in any
 * context: leaving it produced a bare `\` "command" (429 occurrences in the
 * corpus) and split one invocation into two atoms, double-counting it.
 */
function joinLineContinuations(command: string): string {
  return command.replace(/\\\r?\n/g, ' ');
}

/**
 * Consume heredoc bodies starting at `from`, returning the index just past the
 * last terminator. An UNTERMINATED heredoc (a truncated transcript entry)
 * consumes to end of input — the body is still body, and atomizing it would
 * manufacture exactly the fake commands this module exists to stop.
 */
function consumeHeredocBodies(command: string, from: number, pending: PendingHeredoc[]): number {
  let cursor = from;
  for (const heredoc of pending) {
    while (cursor < command.length) {
      const lineEnd = command.indexOf('\n', cursor);
      const end = lineEnd === -1 ? command.length : lineEnd;
      const line = command.slice(cursor, end);
      cursor = end + 1;
      const probe = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe.trim() === heredoc.terminator) break;
    }
  }
  return Math.min(cursor, command.length);
}

/**
 * Split on `||`, `&&`, `|`, `;` and newline — but only where the shell would:
 * outside quotes, outside a heredoc body, and after continuations are joined.
 *
 * An unterminated quote runs to end of input as one atom. That is deliberate:
 * over-joining costs at most a missed advisory, whereas splitting inside a quote
 * fabricates an atom that never existed.
 */
function splitAtCommandDepth(command: string): string[] {
  const atoms: string[] = [];
  let buffer = '';
  let quote: string | null = null;
  let pending: PendingHeredoc[] = [];
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (quote) {
      // A backslash escapes inside double quotes and backticks, but NOT inside
      // single quotes, where every byte until the next `'` is literal.
      if (ch === '\\' && quote !== "'" && i + 1 < command.length) {
        buffer += ch + command[i + 1];
        i += 2;
        continue;
      }
      buffer += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      buffer += ch + command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buffer += ch;
      i += 1;
      continue;
    }

    if (ch === '<' && command.startsWith('<<', i)) {
      const introducer = HEREDOC_INTRODUCER.exec(command.slice(i));
      if (introducer) {
        pending.push({ terminator: introducer[3], stripTabs: introducer[1] === '-' });
        buffer += introducer[0];
        i += introducer[0].length;
        continue;
      }
    }

    if (ch === '\n') {
      if (pending.length > 0) {
        // The body belongs to the atom that introduced it, so it is skipped
        // rather than scanned — but the newline ENDING the terminator line is
        // still a real separator, so the introducing command closes here. (Not
        // closing it fused the heredoc's command with the one after the
        // terminator, turning two atoms into one.)
        i = consumeHeredocBodies(command, i + 1, pending);
        pending = [];
        atoms.push(buffer);
        buffer = '';
        continue;
      }
      atoms.push(buffer);
      buffer = '';
      i += 1;
      continue;
    }

    if (command.startsWith('||', i) || command.startsWith('&&', i)) {
      atoms.push(buffer);
      buffer = '';
      i += 2;
      continue;
    }

    if (ch === '|' || ch === ';') {
      atoms.push(buffer);
      buffer = '';
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  atoms.push(buffer);
  return atoms;
}

/**
 * Normalise ONE atom: strip runner wrappers, env assignments and command-position
 * reserved words so the command verb is at position 0. Applied repeatedly because
 * the forms interleave (`sudo PGPASSWORD=x psql`, `until ! pgrep -f w`).
 */
export function normalizeAtom(atom: string): string {
  let out = atom.trim();
  for (;;) {
    const stripped = out
      .replace(RUNNER_PREFIX, '')
      .replace(ENV_PREFIX, '')
      .replace(KEYWORD_PREFIX, '')
      .trim();
    if (stripped === out) return out;
    out = stripped;
  }
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

/**
 * Is this atom shell SYNTAX rather than a command an agent ran?
 *
 * True for a closing keyword (`done`, `fi`, `esac`, `}`), for a compound header
 * whose remainder is a word list (`for f in a b`, `case $x in`), and for an atom
 * with no recognisable verb at all. Exported so the census can report how many
 * atoms it discards and why, rather than silently shrinking a number nobody can
 * then reconcile against the previous baseline.
 */
export function isShellSyntaxAtom(atom: string): boolean {
  const head = atomHead(atom);
  if (head === null) return true;
  return SYNTAX_HEADS.has(head);
}

/**
 * Split a command line into normalised, non-empty COMMAND atoms.
 *
 * Shell syntax and heredoc/inline-script bodies are excluded — see
 * {@link isShellSyntaxAtom} and the module header. Use
 * {@link splitAtCommandDepth} directly if you need the raw split including
 * syntax (the census does, to report what it discarded).
 *
 * @example
 *   atomize("cd /repo && sed -n '1,40p' a.ts | head -5")
 *   // => ["cd /repo", "sed -n '1,40p' a.ts", "head -5"]
 *   atomize("for f in a b; do node t.mjs | head -3; done")
 *   // => ["node t.mjs", "head -3"]
 */
export function atomize(command: string): string[] {
  return splitAtCommandDepth(joinLineContinuations(command))
    .map((part) => normalizeAtom(part))
    .filter((part) => part.length > 0 && !isShellSyntaxAtom(part));
}

/**
 * The raw split, before syntax atoms are discarded — for the census, which must
 * report the discarded population rather than just a smaller total.
 */
export function atomizeIncludingSyntax(command: string): string[] {
  return splitAtCommandDepth(joinLineContinuations(command))
    .map((part) => normalizeAtom(part))
    .filter((part) => part.length > 0);
}
