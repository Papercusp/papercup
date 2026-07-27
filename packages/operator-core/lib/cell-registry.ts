/**
 * cell-registry.ts — the agent state-plane CELL REGISTRY and its registration gate.
 *
 * Plan: unified-agent-state-plane-2026-07-27 (P-003). The contract it enforces is
 * that plan's D-038 (six axes), refined by D-039 (how P-003 enforces them).
 *
 * WHAT A CELL IS. A named piece of agent-readable state with exactly ONE resolver.
 * Storage does NOT move (D-004): each resolver reads its existing store. The point
 * is to unify the read/subscribe CONTRACT, not to merge 28 tables. An agent reads a
 * cell at the moment of acting instead of trusting a value someone transcribed forty
 * minutes ago — cells are justified by RE-DERIVABILITY, not by being better-formatted
 * than prose (D-032; the presentation question was tested and settled nothing, D-034).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHY REGISTRATION IS A GATE AND NOT A FORM
 *
 * D-016/P-017: a rule whose only enforcement is documentation is not a rule. Every
 * axis below that CAN be checked mechanically IS checked here, at registration, and
 * a violation is a hard refusal. The axes are not advice to resolver authors; they
 * are preconditions of being in this map at all.
 *
 * The failure mode this exists to prevent is specific and has a measured base rate:
 * `predicate_watches` is shipped, correct in principle, and has NEVER been adopted
 * (0 rows, all tenants, 2026-07-27). D-010 therefore makes the adoption gate a
 * PRECONDITION of this registry shipping, not a follow-up — see
 * `scripts/check-no-bespoke-state-read.mjs` (`npm run lint:no-bespoke-state-read`).
 * A registry nobody registers into is surface #29 and strictly worse than today.
 *
 * ⚠ The validator below is deliberately domain-free (it knows about falsifiers and
 * three-valued verdicts, not about git or systemd). If a second consumer appears it
 * should be lifted to `libs/generic/*` behind a configure*() seam per the repo's
 * generic-first rule; it lives here for now because it has exactly one consumer.
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * D-038 axis 2's enumerated unknown comes from `cell-contract.ts`, which declares
 * itself THE CANONICAL HOME and forbids re-declaring a local copy. Re-exported here
 * so a cell author needs one import, not two — a re-export is a lens, not a second
 * derivation, which is the same distinction axis 5 draws one level up at the resolver.
 */
export {
  cellUnknown,
  formatCellUnknown,
  type CellUnknown,
  type CellUnknownCode,
} from './cell-contract';

/**
 * D-038 axis 3 — caller-relativity is DECLARED, never inferred.
 *
 * Inference is not merely unreliable, it is wrong in the confident direction: an
 * inferring registry inspecting `dev:listening_ports` would find no caller parameter
 * and conclude `global`. It is in fact relative to the caller's uid — relativity the
 * resolver cannot see and the caller cannot pass. Hence `ambient` as a first-class
 * kind, and hence `global` being something you SAY rather than something you omit.
 */
export type CallerRelativity =
  /** The same for every caller. A stated decision, not an absent field. */
  | { kind: 'global' }
  /** Relative to an explicit argument — e.g. git answers per-path natively. */
  | { kind: 'parameter'; param: string }
  /** Relative to something the caller never passes — e.g. the caller's uid. */
  | { kind: 'ambient'; source: string };

/**
 * D-038 axis 1 — the dimension that can FALSIFY the reading of the headline value.
 * Which dimension that is, is per-cell: derivation level (session), subject
 * (pipeline), or existence (unit).
 *
 * `measurement` is the load-bearing field. A derived verdict over a raw leg adds
 * interpretation but NO NEW INFORMATION — it is recomputable from the leg. A real
 * falsifier comes from an INDEPENDENT measurement. Without this field a cell can
 * "declare health" while only re-projecting its own position, which is a confident
 * wrong answer wearing the contract's badge.
 */
export interface CellFalsifier {
  /** Field path of the falsifying dimension. */
  field: string;
  /** The independent measurement it comes from. Must not be the headline. */
  measurement: string;
  /** The false reading it kills, stated concretely. */
  kills: string;
}

/** D-038 axis 4 — no cell may be registered on FIXTURE evidence alone. A fixture
 *  cannot catch a resolver that is fresh, correctly-versioned and confidently wrong
 *  (the `realGit` class), so registration demands a live-exercise attestation. */
export interface CellProvenance {
  /** How the value is obtained (e.g. 'git rev-list against the live repo'). */
  obtainedBy: string;
  /** Was the resolver exercised against REALITY, not only fixtures? */
  liveExercised: boolean;
  /** Pointer to that exercise — what was run, and what it showed. */
  evidence: string;
}

export interface CellSpec {
  /** Dotted id, e.g. `git.pipelinePosition`. Unique across the registry. */
  cell: string;
  /** Who owns the resolver — an agent id or a plan slug. */
  owner: string;
  /** Field path of the headline value this cell answers with. */
  headline: string;
  /** Axis 1. */
  falsifier: CellFalsifier;
  /** Axis 2 — can the verdict be unknown? If so the rules below bind. */
  nullable: boolean;
  /**
   * Axis 2 as refined by D-039 — HOISTING. In-band is necessary but NOT sufficient:
   * a per-row qualifier a caller can skip past is how the defect survives contact
   * with a hurried consumer. Required when `nullable`: a RESULT-level field (a count
   * or an affected-subject list) that a caller who never reads the per-row qualifier
   * still cannot miss. Modelled on `unitsUnknown[]` and `ownerHidden`.
   */
  unknownHoist?: string;
  /** Axis 3. */
  callerRelativity: CallerRelativity;
  /** Axis 4. */
  provenance: CellProvenance;
  /**
   * Axis 5 — ONE derivation, many lenses. Exactly one resolver; surfaces may PROJECT
   * or subset it and may NEVER re-derive it. Generalises
   * `presence-derivation-unification-2026-07-17` #D-001, whose enforcement model is
   * `agent-tools/coordination/liveness-parity.test.ts`.
   */
  resolver: string;
  /** How a subscriber learns it changed. `poll` rides predicate_watches (P-004 is
   *  wiring, not a build); do NOT add a second subscription mechanism. */
  changeSignal: { kind: 'poll'; tool: string; path: string } | { kind: 'event'; key: string };
  /** Human-readable result shape. */
  shape: string;
  /**
   * Axis 6 — OPTIONAL. Only a cell with a genuine total stage order declares this.
   * ABSENCE MEANS "THIS CELL HAS NO OPINION", NEVER "CLEAR" — forcing it on orderless
   * cells makes them report null/null, which readers take as "nothing to do",
   * manufacturing false all-clears by construction at fleet scale.
   */
  ordered?: { stages: string[] };
}

export interface CellRejection {
  cell: string;
  axis: 1 | 2 | 3 | 4 | 5;
  rule: string;
  detail: string;
}

/** Normalise for the containment checks — a falsifier that merely re-cases or
 *  re-punctuates the headline is still the headline. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * THE REGISTRATION GATE. Returns every reason a spec may not be registered; an empty
 * array means it may. Pure and total — never throws, so a caller can report ALL
 * violations at once rather than making an author fix them one per run.
 */
export function validateCellSpec(spec: CellSpec): CellRejection[] {
  const out: CellRejection[] = [];
  const reject = (axis: CellRejection['axis'], rule: string, detail: string) =>
    out.push({ cell: spec.cell, axis, rule, detail });

  // ── Axis 1 — the falsifier must not be the headline wearing a hat.
  const headline = norm(spec.headline);
  if (norm(spec.falsifier.field) === headline) {
    reject(1, 'falsifier-is-headline', `falsifier.field "${spec.falsifier.field}" IS the headline value — a cell cannot falsify itself.`);
  }
  const measurement = norm(spec.falsifier.measurement);
  if (measurement === headline || measurement.includes(headline)) {
    reject(1, 'falsifier-derived-from-headline', `falsifier.measurement "${spec.falsifier.measurement}" is derived from the headline. A derived verdict adds interpretation but no new information; a falsifier needs an INDEPENDENT measurement.`);
  }
  if (!spec.falsifier.measurement.trim() || !spec.falsifier.kills.trim()) {
    reject(1, 'falsifier-incomplete', 'falsifier requires both `measurement` (where the independent signal comes from) and `kills` (the false reading it prevents).');
  }

  // ── Axis 2 — three-valued, and the unknown must be enumerated AND hoisted.
  if (spec.nullable && !spec.unknownHoist?.trim()) {
    reject(2, 'unknown-not-hoisted', 'a nullable verdict needs `unknownHoist`: a RESULT-level field a caller who never reads the per-row qualifier still cannot miss. Per-row-only is how the defect survives a hurried consumer.');
  }
  if (!spec.nullable && spec.unknownHoist) {
    reject(2, 'hoist-without-nullable', '`unknownHoist` declared but the verdict is not nullable — one of the two is wrong.');
  }

  // ── Axis 3 — declared, never inferred; `global` is said, not omitted.
  const rel = spec.callerRelativity;
  if (!rel || typeof (rel as { kind?: unknown }).kind !== 'string') {
    reject(3, 'relativity-undeclared', 'callerRelativity is REQUIRED. `{ kind: "global" }` is a valid answer; omission is not — inference concludes `global` for ambient cells, which is wrong in the confident direction.');
  } else if (rel.kind === 'parameter' && !rel.param.trim()) {
    reject(3, 'relativity-parameter-unnamed', 'callerRelativity.kind="parameter" must name the `param`.');
  } else if (rel.kind === 'ambient' && !rel.source.trim()) {
    reject(3, 'relativity-ambient-unnamed', 'callerRelativity.kind="ambient" must name the `source` the caller cannot pass (e.g. "caller uid").');
  }

  // ── Axis 4 — no registration on fixture evidence alone.
  if (!spec.provenance?.liveExercised) {
    reject(4, 'fixture-evidence-only', 'provenance.liveExercised must be true: no cell may be registered on fixture evidence alone. Fixtures cannot catch a fresh, correctly-versioned, confidently-wrong resolver.');
  }
  if (!spec.provenance?.evidence?.trim()) {
    reject(4, 'provenance-unevidenced', 'provenance.evidence must point at the live exercise — what was run and what it showed.');
  }

  // ── Axis 5 — exactly one resolver.
  if (!spec.resolver?.trim()) {
    reject(5, 'no-resolver', 'a cell must name exactly ONE resolver; surfaces may project or subset it, never re-derive it.');
  }

  return out;
}

/** Registered cells, keyed by id. Registration is ONE call — that cheapness is a
 *  D-010 precondition, not a nicety: if registering a cell is not measurably cheaper
 *  than minting a tool, adoption fails and the registry should not ship. */
const CELLS = new Map<string, CellSpec>();

export class CellRegistrationError extends Error {
  constructor(readonly rejections: CellRejection[]) {
    super(
      `cell "${rejections[0]?.cell}" refused by the D-038 contract:\n` +
        rejections.map((r) => `  · axis ${r.axis} [${r.rule}] ${r.detail}`).join('\n'),
    );
    this.name = 'CellRegistrationError';
  }
}

/** Register a cell. THROWS on any contract violation — a refused cell is absent, not
 *  present-and-suspect, because a registered cell reads as system truth and that
 *  raises the cost of a wrong one above what prose ever had. */
export function registerCell(spec: CellSpec): CellSpec {
  const rejections = validateCellSpec(spec);
  if (rejections.length > 0) throw new CellRegistrationError(rejections);
  const existing = CELLS.get(spec.cell);
  if (existing && existing.resolver !== spec.resolver) {
    throw new CellRegistrationError([
      {
        cell: spec.cell,
        axis: 5,
        rule: 'duplicate-resolver',
        detail: `"${spec.cell}" is already registered with resolver "${existing.resolver}". One derivation, many lenses — project the existing cell instead of re-deriving it.`,
      },
    ]);
  }
  CELLS.set(spec.cell, spec);
  return spec;
}

export function getCell(cell: string): CellSpec | undefined {
  return CELLS.get(cell);
}

export function listCells(): CellSpec[] {
  return [...CELLS.values()].sort((a, b) => a.cell.localeCompare(b.cell));
}

/** Test seam — drops every registration. */
export function __resetCellRegistryForTests(): void {
  CELLS.clear();
}
