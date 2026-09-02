/**
 * Extract the EXECUTABLE CLAIMS a prescriptive markdown doc makes — the commands
 * it tells a reader to RUN — so a test can assert they actually work
 * (false-premise-in-prescriptive-artifacts-2026-08-02 P-004).
 *
 * The live instance: CLAUDE.md § "Adding a tool" MANDATES
 * `cd packages/operator-core && npx vitest run tools-md-sync` as a pre-commit
 * check, and the heavy-command admission gate REFUSES that exact command under
 * fleet load (EI-19364889235428417). A doc prescribing a command the system
 * rejects is the same false-premise class the rest of this plan addresses, one
 * layer up: the author believed it, and nothing re-checked it.
 *
 * ── Why this extracts by PRESCRIPTION SITE, not by negation cue ──
 *
 * A prescriptive doc is full of commands it is telling you NOT to run — this
 * repo's CLAUDE.md carries `| use | not |` routing tables, 🚨 destructive-git
 * warnings, and side-by-side right/wrong exhibits. Firing on those would make
 * the test fail hardest on the BEST-documented sections, which is precisely the
 * inversion P-002 measured (its detector fired hardest on the best-evidenced
 * work-items until pasted error output was stripped).
 *
 * The first implementation tried the obvious thing — treat a command as
 * proscribed when its line carries a negation cue (never/not/don't/⚠). MEASURED
 * against the real CLAUDE.md, that is wrong in BOTH directions:
 *
 *   FALSE PRESCRIBED  `git reset --hard HEAD`      (inside the 🚨 do-not-run block)
 *                     `git.pipelinePosition`        (a state-cell name, not a command)
 *   FALSE PROSCRIBED  `npm run install:safe`        ("cannot" elsewhere on the line)
 *                     `npm run lint:required-field-strands`
 *
 * Dense prose says "not"/"never"/"cannot" constantly for unrelated reasons, so
 * proximity carries almost no signal. This module therefore WHITELISTS the three
 * sites where this doc genuinely prescribes, and treats everything else as
 * unknown → skipped. That is D-001 constraint 2 (fail OPEN in every uncertain
 * direction) applied to a detector: a missed prescription costs nothing, a
 * fabricated one costs a red gate and trains readers to ignore the check.
 *
 * Measured on CLAUDE.md at authoring time: 109 command-shaped spans in the file,
 * 13 prescription sites, 11 checkable after placeholder removal, 11/11 genuine
 * prescriptions on inspection, and the known-bad line among them.
 *
 * ⚠ BEFORE POINTING THIS AT ANOTHER DOCUMENT, RE-MEASURE ITS PRESCRIPTION VOICE.
 *
 * The three sites above are calibrated to how CLAUDE.md prescribes (numbered
 * `**Run** \`cmd\`` steps, ```bash fences, `| use | not |` tables). They do NOT
 * generalise for free, and the failure is SILENT — it reports "clean", not
 * "unsupported".
 *
 * Measured, on the su prompt artifacts (`apps/operator/prompts/…`): this
 * extractor finds ZERO prescriptions in all three, because they prescribe in a
 * declarative voice instead — ``docs don't hot-reload — `cd apps/operator-docs
 * && npm run build` regenerates the served mirror`` names no imperative before
 * the span. That file contains a REAL instance of this very defect (`npm run
 * build` is refused by the same gate), so running this check against it would
 * have returned a confident all-clear over a known-bad line — the "checked zero
 * files, therefore green" shape CLAUDE.md warns about for `tsc -p .`.
 *
 * So: a new target document needs its own measured site set, and a
 * `prescribed.length === 0` result on a non-trivial doc should be read as "the
 * voice is unsupported", never as "the doc is clean". The npm-run leg has no
 * such dependency — it keys on command text alone and travels fine.
 */

/** A site where this document genuinely tells the reader to run something. */
export type PrescriptionSite =
  /** inside a ```bash / ```sh fence — the doc's own "here is the command" form */
  | 'fence:bash'
  /** an explicit imperative immediately before the span: `**Run** \`cmd\`` */
  | 'imperative:run'
  /** the prescribed column of a `| you want | use | not |` routing table */
  | 'table:use';

export interface PrescribedCommand {
  /** 1-based line in the source markdown. */
  line: number;
  command: string;
  site: PrescriptionSite;
}

export interface SkippedCommand extends PrescribedCommand {
  reason: 'placeholder';
}

export interface NpmRunMention {
  line: number;
  /** the script name, e.g. `test:file` */
  script: string;
  /**
   * A directory the command names EXPLICITLY (`cd d && …`, `--prefix d`,
   * `--workspace d`). `null` when the owning package is established only by
   * surrounding prose — the common case, and the reason the caller must not
   * assume the repo root (measured: 6 of 7 apparent failures were this).
   */
  explicitDir: string | null;
}

export interface ExtractionResult {
  prescribed: PrescribedCommand[];
  skipped: SkippedCommand[];
  npmRun: NpmRunMention[];
}

/**
 * A span carrying a metavariable is not runnable AS WRITTEN, so neither
 * assertion can say anything true about it. Skipped, never failed.
 */
const PLACEHOLDER = /[<>]|…|\.\.\./;

/** Executables whose invocations this repo's docs actually prescribe. */
const EXE = '(?:npm|npx|node|bash|sh|git|psql|systemctl|pgrep|pkill|turbo|vitest|tsc|curl)';

/**
 * An INVOCATION, not a mention. Requires at least one argument after the
 * executable, which is what separates `tsc -p tsconfig.json` from the bare word
 * `tsc` used as a noun ("vitest does not typecheck"). Allows a leading
 * `cd <dir> &&` and env assignments, both of which this doc uses constantly.
 */
const INVOCATION = new RegExp(
  `^(?:cd\\s+[^\\s&|;]+\\s*&&\\s*)?(?:[A-Za-z_]\\w*=\\S*\\s+)*${EXE}(?:\\s+\\S+)+`,
);

/** `git.pipelinePosition` — a dotted identifier, never a command. */
const DOTTED_IDENTIFIER = /^\w+\.\w/;
/** `vitest: not found` — pasted error text, never a command. */
const ERROR_TEXT = /^\w+:\s/;

function isInvocation(raw: string): boolean {
  if (DOTTED_IDENTIFIER.test(raw) || ERROR_TEXT.test(raw)) return false;
  return INVOCATION.test(raw);
}

/**
 * A right/wrong exhibit line (`cmd  -> result  <- FALSE NEGATIVE`). These sit
 * inside fences precisely to show a form that does NOT work.
 */
const EXHIBIT = /->|<-|→/;

interface Atom {
  line: number;
  text: string;
  /** index of this atom's cell within its table row, or null when not in a table */
  tableCell: number | null;
  tableUseCell: number | null;
  precededByRun: boolean;
  fenceLang: string | null;
  isExhibit: boolean;
}

interface TableGeometry {
  /** index of the `not` column; the prescribed column is the one before it */
  useCell: number;
}

/** Map 1-based line → the table geometry governing it, for `| … | use | not |`. */
function tableGeometry(lines: string[]): Map<number, TableGeometry> {
  const out = new Map<number, TableGeometry>();
  let header: TableGeometry | null = null;
  let sawHeader = false;
  lines.forEach((line, i) => {
    if (!/^\s*\|/.test(line)) {
      header = null;
      sawHeader = false;
      return;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length && cells.every((c) => /^:?-+:?$/.test(c))) return; // separator
    if (!sawHeader) {
      sawHeader = true;
      const notIdx = cells.findIndex((c) => /^not$/i.test(c));
      header = notIdx > 0 ? { useCell: notIdx - 1 } : null;
      return;
    }
    if (header) out.set(i + 1, header);
  });
  return out;
}

/** Which `|`-delimited cell does `offset` fall in? (slice(1,-1) basis, -1 = none) */
function cellIndexOf(line: string, offset: number): number {
  const parts = line.split('|');
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const start = pos + (i === 0 ? 0 : 1);
    const end = start + parts[i].length;
    if (offset >= start && offset < end) return i - 1;
    pos = end;
  }
  return -1;
}

/** Collect every command-shaped atom: backticked spans and fenced code lines. */
function atoms(markdown: string): Atom[] {
  const lines = markdown.split('\n');
  const geometry = tableGeometry(lines);
  const out: Atom[] = [];

  let fenceLang: string | null = null;
  lines.forEach((raw, i) => {
    const fence = raw.match(/^\s*```(\w*)/);
    if (fence) {
      fenceLang = fenceLang === null ? fence[1] || '' : null;
      return;
    }

    if (fenceLang !== null) {
      const stripped = raw.replace(/\s+#.*$/, '').trim();
      if (!stripped || stripped.startsWith('#')) return;
      out.push({
        line: i + 1,
        text: stripped,
        tableCell: null,
        tableUseCell: null,
        precededByRun: false,
        fenceLang,
        isExhibit: EXHIBIT.test(raw),
      });
      return;
    }

    const geo = geometry.get(i + 1) ?? null;
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const before = raw.slice(0, m.index ?? 0);
      out.push({
        line: i + 1,
        text: m[1].trim(),
        tableCell: geo ? cellIndexOf(raw, m.index ?? 0) : null,
        tableUseCell: geo ? geo.useCell : null,
        precededByRun: /(?:^|[\s>*_(])(?:\*\*)?[Rr]un(?:\*\*)?:?\s*$/.test(before),
        fenceLang: null,
        isExhibit: false,
      });
    }
  });
  return out;
}

function siteOf(a: Atom): PrescriptionSite | null {
  if (a.fenceLang !== null) {
    // An UNTAGGED fence is this doc's exhibit convention (side-by-side
    // right/wrong forms), so only bash-tagged fences prescribe.
    if (!['bash', 'sh', 'shell'].includes(a.fenceLang)) return null;
    return a.isExhibit ? null : 'fence:bash';
  }
  if (a.precededByRun) return 'imperative:run';
  if (a.tableUseCell !== null && a.tableCell === a.tableUseCell) return 'table:use';
  return null;
}

/**
 * `npm run X` in every form this doc uses, including the two that relocate the
 * owning package (`npm --prefix d run X`, `npm run --workspace d X`).
 *
 * FLAGS BETWEEN `run` AND THE SCRIPT NAME ARE SKIPPED, and the script name may not
 * BEGIN with `-`:
 *   - The skip is the fix. `npm --prefix papercusp-desktop run --silent test` previously
 *     bound `--silent` as the script (the old class `[A-Za-z0-9:_-]+` admits a leading
 *     `-`), so the guard reported "names no such script" and held the green gate red on
 *     candidate 43f55c09 — a FALSE POSITIVE against a line that is correct npm and is
 *     itself documenting the sanctioned invocation for the one app-dir deliberately kept
 *     out of the root workspaces (EI-22152426246970496).
 *   - The leading-`-` ban is a BACKSTOP with a known, deliberate trade. It guarantees a
 *     flag can never be mis-bound AS a script (the false-positive direction, which reds
 *     the fleet). Its cost: a flag shape this skip does not anticipate makes the whole
 *     mention fail to match, so it is silently DROPPED — the false-ABSENCE direction.
 *     That is the lesser evil here (one unchecked claim vs a fleet-wide red), and the
 *     flag class is kept wide enough to cover the forms npm actually accepts. If you
 *     widen the doc's flag vocabulary, widen this class with it.
 */
const NPM_RUN =
  /npm\s+(?:--prefix[= ](\S+)\s+)?run\s+(?:--workspace[= ](\S+)\s+)?(?:--[A-Za-z][A-Za-z0-9-]*(?:=\S+)?\s+)*([A-Za-z0-9:_][A-Za-z0-9:_-]*)/g;
const LEADING_CD = /^cd\s+([^\s&|;]+)\s*&&/;

export function extractExecutableClaims(markdown: string): ExtractionResult {
  const prescribed: PrescribedCommand[] = [];
  const skipped: SkippedCommand[] = [];
  const npmRun: NpmRunMention[] = [];

  for (const a of atoms(markdown)) {
    // ── npm-run mentions: extracted from EVERY atom, prescribed or not ──
    // A script name that resolves nowhere is a defect in either column, so this
    // leg deliberately needs no prescription judgement.
    for (const m of a.text.matchAll(NPM_RUN)) {
      const [, prefixDir, workspaceDir, script] = m;
      if (PLACEHOLDER.test(script)) continue;
      const cd = a.text.match(LEADING_CD)?.[1] ?? null;
      const dir = prefixDir ?? workspaceDir ?? cd;
      npmRun.push({
        line: a.line,
        script,
        explicitDir: dir && !PLACEHOLDER.test(dir) ? dir : null,
      });
    }

    // ── prescriptions: only from a recognised prescription site ──
    if (!isInvocation(a.text)) continue;
    const site = siteOf(a);
    if (!site) continue;
    const record = { line: a.line, command: a.text, site };
    if (PLACEHOLDER.test(a.text)) skipped.push({ ...record, reason: 'placeholder' });
    else prescribed.push(record);
  }

  return { prescribed, skipped, npmRun };
}
