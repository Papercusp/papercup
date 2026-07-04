/**
 * Multi-template composition semantics (plan app-templates-2026-07-04 P-014;
 * owner directive: ONE app = a composition of MANY templates).
 *
 * Two distinct validations:
 *
 * - `validateTemplateSet(entries)` — REGISTRY-level anti-rot over the whole
 *   template set (the analog of validateCatalog for components): every entry
 *   parses, ids are unique, and every composesWith reference resolves within
 *   the set. Dangling refs are how a registry rots.
 *
 * - `composeTemplates(templates)` — resolve ONE app's chosen template
 *   selection into a `TemplateComposition`. This is the machine half of the
 *   composition rules the design doc states (§Composition):
 *     · at most ONE scope:'app' template per composition (two whole-app
 *       scaffolds cannot both own an app);
 *     · component pins must be CONSISTENT — the same catalog component pinned
 *       at two different versions across the selection is a conflict, never
 *       silently resolved;
 *     · everything composes ADDITIVELY as a tagged union — components are
 *       deduped, while blueprints/contracts/decisionPoints/checks keep their
 *       source template id. **The checks union is the load-bearing rule: an
 *       app built from N templates must pass ALL N templates' checks.**
 *
 * v1 scope (owner decision): schema support + these semantics + manual
 * composition documented in each GUIDE. Automated composition TOOLING (the
 * materializer walking composesWith, prompting per decision point) is v1.1 —
 * this module stays pure so that tooling can sit on top of it unchanged.
 * `composesWith` is a design-affinity declaration, not a dependency edge: a
 * composition may include templates that never name each other.
 */
import type {
  TemplateCheck,
  TemplateComponentRef,
  TemplateDecisionPoint,
  TemplateManifest,
  TemplateScope,
} from "./template-manifest.js";
import { validateTemplateManifest } from "./template-manifest.js";

/** An item of the additive union, tagged with the template that contributed it. */
export interface ComposedFrom<T> {
  templateId: string;
  item: T;
}

/** The resolved result of composing one selection of templates. */
export interface TemplateComposition {
  /** Template ids in the composition, in input order. */
  templateIds: string[];
  /** 'app' when the selection contains an app-scope template, else 'aspect'. */
  scope: TemplateScope;
  /** The single app-scope template when present. */
  appTemplateId?: string;
  /** Deduped union of component refs (pins verified consistent across the set). */
  components: TemplateComponentRef[];
  /** Additive union — each entry keeps its source template. */
  blueprints: ComposedFrom<string>[];
  contracts: ComposedFrom<string>[];
  decisionPoints: ComposedFrom<TemplateDecisionPoint>[];
  /**
   * THE union-of-checks: an app built from this composition is done only when
   * every entry here is green. Check ids are unique per-template, not
   * per-composition — key by (templateId, check.id).
   */
  checks: ComposedFrom<TemplateCheck>[];
}

/**
 * Registry-level validation of a whole template set: every entry validates as
 * a TemplateManifest, ids are unique, and every composesWith reference
 * resolves to a template id in the set. Returns EVERY problem.
 */
export function validateTemplateSet(entries: unknown[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();
  const manifests: TemplateManifest[] = [];
  entries.forEach((e, i) => {
    const v = validateTemplateManifest(e);
    if (!v.ok) {
      errors.push(...v.errors.map((msg) => `entry[${i}]: ${msg}`));
      return;
    }
    const m = e as TemplateManifest;
    if (ids.has(m.id)) errors.push(`entry[${i}]: duplicate template id '${m.id}'`);
    ids.add(m.id);
    manifests.push(m);
  });
  for (const m of manifests) {
    for (const ref of m.composesWith) {
      if (!ids.has(ref)) errors.push(`'${m.id}' composesWith unknown template '${ref}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Resolve one app's template selection into a TemplateComposition.
 * Returns EVERY problem; `composition` is null unless ok.
 */
export function composeTemplates(
  templates: TemplateManifest[],
): { ok: boolean; errors: string[]; composition: TemplateComposition | null } {
  const errors: string[] = [];
  if (templates.length === 0) {
    return { ok: false, errors: ["composition requires at least one template"], composition: null };
  }

  const seen = new Set<string>();
  for (const t of templates) {
    if (seen.has(t.id)) errors.push(`duplicate template '${t.id}' in the composition`);
    seen.add(t.id);
  }

  const appTemplates = templates.filter((t) => t.scope === "app");
  if (appTemplates.length > 1) {
    errors.push(
      `at most ONE app-scope template per composition — got ${appTemplates.map((t) => `'${t.id}'`).join(", ")}`,
    );
  }

  // Component pin consistency: same component id at two versions = conflict.
  const pins = new Map<string, { version: string; templateId: string }>();
  const components: TemplateComponentRef[] = [];
  for (const t of templates) {
    for (const ref of t.components) {
      const prior = pins.get(ref.id);
      if (!prior) {
        pins.set(ref.id, { version: ref.version, templateId: t.id });
        components.push({ id: ref.id, version: ref.version });
      } else if (prior.version !== ref.version) {
        errors.push(
          `component pin conflict on '${ref.id}': '${prior.templateId}' pins ${prior.version}, '${t.id}' pins ${ref.version}`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, composition: null };

  const tag = <T>(templateId: string, items: readonly T[]): ComposedFrom<T>[] =>
    items.map((item) => ({ templateId, item }));

  const composition: TemplateComposition = {
    templateIds: templates.map((t) => t.id),
    scope: appTemplates.length === 1 ? "app" : "aspect",
    ...(appTemplates.length === 1 ? { appTemplateId: appTemplates[0]!.id } : {}),
    components,
    blueprints: templates.flatMap((t) => tag(t.id, t.blueprints ?? [])),
    contracts: templates.flatMap((t) => tag(t.id, t.contracts)),
    decisionPoints: templates.flatMap((t) => tag(t.id, t.decisionPoints)),
    checks: templates.flatMap((t) => tag(t.id, t.checks)),
  };
  return { ok: true, errors: [], composition };
}
