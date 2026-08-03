/**
 * pack-residue — the ONE rule for "this text is not fit to ship in a knowledge
 * pack" (memory-corpus-hygiene P-006 / D-017).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RELEASE-BUNDLE AUDIT
 *
 * `papercusp-desktop/bin/audit-release-bundle.py` already scans the cut for
 * identity — but its rule is BUILD-BOX identity: the unix user, hostname and
 * git identity of the machine doing the build, resolved at run time. That is a
 * different hazard from the one here. A knowledge-pack item is authored by the
 * FLEET, out of our own ledger, so the residue it carries is internal
 * REFERENCES — work-item ids, `harness:<slug>` scope literals, recurrence
 * signature hashes. None of those are machine identity, so the release audit
 * passes them through, and they land on a fresh install as dangling pointers
 * into a ledger the reader has never seen.
 *
 * Measured 2026-08-03: all three items in the live `fleet-lessons` pack carried
 * a provenance footer naming EI-8288 / EI-9411 / harness:@singleton /
 * harness:papercusp-workspace plus a 12-hex signature — and the release audit
 * did not flag any of it, because none of it is this box's identity.
 *
 * The producing path was fixed at source (renderCandidateLearningFile no longer
 * renders any of it). This module is the RECURRENCE GUARD for the class: it is
 * asserted over the committed builtin packs by pack-residue.test.ts, and the
 * fleet-lessons exporter refuses to export a pack that trips it. One rule, two
 * call sites — never a second copy that can drift (the same one-rule discipline
 * audit-release-bundle.py applies to its tar-excludes / identity-literals).
 *
 * DELIBERATELY NARROW. Each rule below is a class we have actually observed
 * shipping, with a falsifiable pattern. This is not a general prose linter, and
 * it must stay cheap enough to run over every pack item on every test run.
 */

export interface PackResidueRule {
  /** Stable id — what the failure is called when it fires. */
  id: string;
  /** The pattern. Global + multiline so every occurrence is reported. */
  pattern: RegExp;
  /** Why this must not ship, phrased for whoever just tripped it. */
  why: string;
}

/**
 * NOTE on the hex rule's width: a recurrence signature is a 12-hex digest
 * (e.g. `5741efa1c7dd`). The bound is `{12,}` rather than `{7,}` so ordinary
 * prose — and a legitimate lesson that quotes a short git sha — does not trip
 * it. A shipped pack item has no business quoting a 12+ hex digest at all.
 */
export const PACK_RESIDUE_RULES: readonly PackResidueRule[] = [
  {
    id: 'ledger-id',
    pattern: /\b(?:EI|WI)-\d+\b/g,
    why:
      'internal work-item ids are dangling references on any install but ours — ' +
      'the reader cannot resolve them, so they are noise that looks like a citation',
  },
  {
    id: 'scope-literal',
    pattern: /\bharness:[A-Za-z0-9@._-]+/g,
    why:
      'a `harness:<slug>` scope literal names OUR boxes/workspaces — ' +
      'it is meaningless to a stranger and leaks our topology',
  },
  {
    id: 'signature-hash',
    pattern: /\b[0-9a-f]{12,}\b/g,
    why:
      'a recurrence signature digest is an internal grouping key — ' +
      'it carries no transferable meaning and cannot be looked up off-fleet',
  },
] as const;

export interface PackResidueHit {
  /** Which rule fired. */
  rule: string;
  /** The offending text, verbatim. */
  match: string;
  /** Why it must not ship (from the rule). */
  why: string;
}

/**
 * Every residue occurrence in `text`, in rule order. Empty array = fit to ship.
 *
 * Returns the offending SUBSTRINGS, not just a boolean, so a caller can name
 * exactly what tripped — a bare "this pack has residue" is the kind of finding
 * that gets worked around instead of fixed.
 */
export function findPackResidue(text: string): PackResidueHit[] {
  const hits: PackResidueHit[] = [];
  for (const rule of PACK_RESIDUE_RULES) {
    // Fresh lastIndex per call: the module-level regexes are /g and stateful.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const m of text.matchAll(re)) {
      hits.push({ rule: rule.id, match: m[0], why: rule.why });
    }
  }
  return hits;
}

/** One-line-per-hit rendering for a CLI refusal or a test failure message. */
export function formatPackResidue(hits: readonly PackResidueHit[]): string {
  return hits.map((h) => `  [${h.rule}] ${JSON.stringify(h.match)} — ${h.why}`).join('\n');
}
