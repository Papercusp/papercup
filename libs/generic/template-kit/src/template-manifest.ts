/**
 * template.yaml schema — the machine-readable half of ONE template
 * (plan app-templates-2026-07-04 P-005; anatomy in
 * agent-insights/templates-system-design).
 *
 * A template = components (version-pinned catalog refs) + guidance (GUIDE.md)
 * + checks (the acceptance suite). template.yaml says *what exists*; GUIDE.md
 * says *how to think about composing it*. This module is what the Cupboard
 * listing and the materializer read.
 *
 * Validation is PURE + zero-dep, exactly like component-manifest.ts: the
 * consumer parses the YAML with whatever loader it already has and passes the
 * resulting object here — this lib never takes a yaml runtime dep.
 * `validateTemplateManifest` returns EVERY problem (never throws);
 * `parseTemplateManifest` throws one Error listing them all.
 *
 * Cross-validation against the component catalog
 * (`validateTemplateAgainstCatalog`) keeps refs honest: every component ref
 * must resolve to a catalog id, and its version pin must match the catalog's
 * current version (the catalog holds exactly one living version per
 * component, so a mismatched pin is rot, not history — the anti-rot gym
 * P-009 re-runs this).
 *
 * Multi-template composition SEMANTICS (how `scope`/`composesWith` stack, the
 * union-of-checks rule) land in P-014 — this module only carries the fields.
 */
import type { ComponentManifest } from "./component-manifest.js";

/** D-006: a whole-app scaffold vs a capability composed INTO an app. */
export type TemplateScope = "app" | "aspect";

/** A version-pinned reference to a catalog component — never a vendored copy. */
export interface TemplateComponentRef {
  /** Component catalog id (kebab-case). */
  id: string;
  /** Exact semver pin; must match the catalog's current version. */
  version: string;
}

/** A declared decision point — where agent judgment is explicitly invited. */
export interface TemplateDecisionPoint {
  /** kebab-case id, unique within the template (`seam-work-item-kind`). */
  id: string;
  /** The question the building agent must answer; GUIDE.md expands on it. */
  prompt: string;
}

/** One app-parameterized acceptance check shipped in checks/. */
export interface TemplateCheck {
  /** kebab-case id, unique within the template (`seam-round-trip`). */
  id: string;
  /** Template-relative entry point (a checks/ file or command). */
  run: string;
  /** One-line statement of what green means. */
  summary?: string;
}

export interface TemplateManifest {
  /** kebab-case template id, unique across the template set. */
  id: string;
  /** semver of the template itself (`0.1.0`). */
  version: string;
  /** app (whole-app scaffold) | aspect (composed into an app) — D-006. */
  scope: TemplateScope;
  /** One-paragraph human description (the Cupboard listing text). */
  summary: string;
  /**
   * Version-pinned catalog refs. Non-empty UNLESS the template is a pure
   * composition (non-empty composesWith) — an app-scope template is typically
   * a thin composition of aspect templates and may carry no own components
   * (P-014); a template with neither components nor composesWith is a doc,
   * not a template.
   */
  components: TemplateComponentRef[];
  /** OPTIONAL starter blueprint dirs (kebab ids under blueprints/); a design-adoption template ships none. */
  blueprints?: string[];
  /** Typed seam-contract template names under contracts/ (kebab; may be empty for templates that don't cross the seam). */
  contracts: string[];
  /** Declared decision points (may be empty — but an empty list means NO judgment is invited, which is rare by design). */
  decisionPoints: TemplateDecisionPoint[];
  /** Template ids this template is designed to stack with (semantics = P-014; may be empty). */
  composesWith: string[];
  /** The acceptance suite. Non-empty — checks are the load-bearing replacement for the old deterministic generator. */
  checks: TemplateCheck[];
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SCOPES: readonly string[] = ["app", "aspect"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validate an untrusted (already YAML-parsed) value as a TemplateManifest. Returns EVERY problem. */
export function validateTemplateManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["template manifest must be an object"] };

  if (typeof raw.id !== "string" || !KEBAB.test(raw.id)) errors.push("id: required kebab-case string");
  if (typeof raw.version !== "string" || !SEMVER.test(raw.version)) errors.push("version: required semver string (x.y.z)");
  if (typeof raw.scope !== "string" || !SCOPES.includes(raw.scope)) errors.push(`scope: required one of ${SCOPES.join("|")}`);
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") errors.push("summary: required non-empty string");

  if (!Array.isArray(raw.components)) {
    errors.push("components: required array of { id, version }");
  } else if (raw.components.length === 0) {
    // A pure composition (non-empty composesWith) may carry no own components (P-014).
    const composes = isStringArray(raw.composesWith) && raw.composesWith.length > 0;
    if (!composes) errors.push("components: may be empty only for a pure-composition template (non-empty composesWith)");
  } else {
    const seen = new Set<string>();
    raw.components.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`components[${i}]: must be an object { id, version }`);
        return;
      }
      if (typeof c.id !== "string" || !KEBAB.test(c.id)) errors.push(`components[${i}].id: required kebab-case string`);
      if (typeof c.version !== "string" || !SEMVER.test(c.version)) errors.push(`components[${i}].version: required exact semver pin (x.y.z)`);
      if (typeof c.id === "string") {
        if (seen.has(c.id)) errors.push(`components[${i}]: duplicate component ref '${c.id}'`);
        seen.add(c.id);
      }
    });
  }

  if (raw.blueprints !== undefined) {
    if (!isStringArray(raw.blueprints)) {
      errors.push("blueprints: must be string[] when present");
    } else {
      for (const b of raw.blueprints) if (!KEBAB.test(b)) errors.push(`blueprints: '${b}' is not kebab-case`);
    }
  }

  if (!isStringArray(raw.contracts)) {
    errors.push("contracts: required string[] (may be empty)");
  } else {
    for (const c of raw.contracts) if (!KEBAB.test(c)) errors.push(`contracts: '${c}' is not kebab-case`);
  }

  if (!Array.isArray(raw.decisionPoints)) {
    errors.push("decisionPoints: required array of { id, prompt } (may be empty)");
  } else {
    const seen = new Set<string>();
    raw.decisionPoints.forEach((d, i) => {
      if (!isRecord(d)) {
        errors.push(`decisionPoints[${i}]: must be an object { id, prompt }`);
        return;
      }
      if (typeof d.id !== "string" || !KEBAB.test(d.id)) errors.push(`decisionPoints[${i}].id: required kebab-case string`);
      if (typeof d.prompt !== "string" || d.prompt.trim() === "") errors.push(`decisionPoints[${i}].prompt: required non-empty string`);
      if (typeof d.id === "string") {
        if (seen.has(d.id)) errors.push(`decisionPoints[${i}]: duplicate decision point '${d.id}'`);
        seen.add(d.id);
      }
    });
  }

  if (!isStringArray(raw.composesWith)) {
    errors.push("composesWith: required string[] (may be empty)");
  } else {
    for (const t of raw.composesWith) if (!KEBAB.test(t)) errors.push(`composesWith: '${t}' is not kebab-case`);
  }

  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    errors.push("checks: required non-empty array of { id, run } — checks are load-bearing");
  } else {
    const seen = new Set<string>();
    raw.checks.forEach((c, i) => {
      if (!isRecord(c)) {
        errors.push(`checks[${i}]: must be an object { id, run }`);
        return;
      }
      if (typeof c.id !== "string" || !KEBAB.test(c.id)) errors.push(`checks[${i}].id: required kebab-case string`);
      if (typeof c.run !== "string" || c.run.trim() === "") errors.push(`checks[${i}].run: required non-empty string`);
      if (c.summary !== undefined && typeof c.summary !== "string") errors.push(`checks[${i}].summary: must be a string when present`);
      if (typeof c.id === "string") {
        if (seen.has(c.id)) errors.push(`checks[${i}]: duplicate check '${c.id}'`);
        seen.add(c.id);
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

/** Fail-loud form: returns the typed manifest or throws one Error listing every problem. */
export function parseTemplateManifest(raw: unknown): TemplateManifest {
  const { ok, errors } = validateTemplateManifest(raw);
  if (!ok) throw new Error(`invalid template manifest: ${errors.join("; ")}`);
  return raw as TemplateManifest;
}

/**
 * Cross-validate a template's component refs against the component catalog:
 * every ref must resolve to a catalog id, and its pin must match the
 * catalog's CURRENT version (the catalog carries exactly one living version
 * per component — a mismatched pin means the template or the catalog rotted;
 * update whichever is stale). Returns EVERY problem.
 */
export function validateTemplateAgainstCatalog(
  manifest: TemplateManifest,
  catalog: ComponentManifest[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map(catalog.map((c) => [c.id, c]));
  for (const ref of manifest.components) {
    const entry = byId.get(ref.id);
    if (!entry) {
      errors.push(`'${manifest.id}' references unknown component '${ref.id}'`);
      continue;
    }
    if (entry.version !== ref.version) {
      errors.push(
        `'${manifest.id}' pins '${ref.id}@${ref.version}' but the catalog has ${entry.version} (stale pin — update the template or the catalog)`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}
