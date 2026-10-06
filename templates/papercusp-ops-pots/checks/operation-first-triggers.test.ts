/**
 * operation-first-triggers — portable check (plan
 * app-agent-tasks-durable-execution-2026-10-06 P-011).
 *
 * Config (TEMPLATE_CHECKS_CONFIG, see @papercusp/template-kit TemplateChecksConfig):
 *   app.root                // app checkout root
 *   seam.rootBlueprint?     // the app's ROOT blueprint (default .papercusp/blueprint.yaml)
 * Runs whenever a `seam` section is configured (an app composed with
 * papercusp-ops-pots); skips otherwise, like every portable check.
 *
 * What it pins:
 * 1. No trigger in the app's own source creates agent work directly: no binding
 *    whose action type is the direct-create kind, and no trigger target naming
 *    the work-item create tool. Agent tasks are blueprint operations submitted
 *    through the seam client; new bindings carry
 *    `action { type: "blueprint-operation", operationHarnessSlug, operationId }`.
 * 2. Every agent-execution operation in the ROOT blueprint names a worker role
 *    declared in that same file. The orchestrator validator refuses a role that
 *    exists only on a dependency blueprint
 *    (app-agent-tasks-durable-execution-2026-10-06#D-003).
 *
 * The forbidden literals are assembled at runtime so this file never matches
 * itself once copied into the app's `checks/` directory. Built-in controls prove
 * the detector is not vacuous.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// ── config preamble (identical across the portable checks) ──────────────────
const untilde = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const configPath = process.env.TEMPLATE_CHECKS_CONFIG;
const config: Record<string, any> | null = configPath
  ? JSON.parse(readFileSync(resolve(untilde(configPath)), "utf8"))
  : null;
const appRoot: string | null = config
  ? resolve(dirname(resolve(untilde(configPath!))), untilde(config.app?.root ?? "."))
  : null;
const inApp = (p: string): string => (isAbsolute(untilde(p)) ? untilde(p) : join(appRoot!, p));
// ─────────────────────────────────────────────────────────────────────────────

const section = config?.seam as { rootBlueprint?: string } | undefined;

const DIRECT_CREATE_KIND = ["create", "work", "item"].join("-");
const DIRECT_CREATE_TOOL = ["work_items", "create"].join(":");
const DETECTORS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: `trigger action type ${DIRECT_CREATE_KIND}`,
    pattern: new RegExp(`["']?type["']?\\s*[:=]\\s*["']?${DIRECT_CREATE_KIND}\\b`),
  },
  {
    label: `trigger target ${DIRECT_CREATE_TOOL}`,
    pattern: new RegExp(`["']?(target|tool|action)["']?\\s*[:=]\\s*["']${DIRECT_CREATE_TOOL}["']`),
  },
];

/** Returns one `path:line label` finding per forbidden trigger shape in `text`. */
export function findDirectCreateTriggers(text: string, path: string): string[] {
  const findings: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const detector of DETECTORS) {
      if (detector.pattern.test(line)) findings.push(`${path}:${index + 1} ${detector.label}`);
    }
  });
  return findings;
}

const SCANNED_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|ya?ml)$/;
const SKIPPED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "target", ".next", ".turbo",
  ".vitest-tmp", "checks", "dist-sidecar", "dist-spa",
]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (SCANNED_EXTENSIONS.test(name) && stat.size < 2_000_000) yield full;
  }
}

describe("operation-first-triggers detector controls", () => {
  it("flags each forbidden trigger shape (positive controls)", () => {
    const yamlBinding = `action:\n  type: ${DIRECT_CREATE_KIND}\n`;
    const jsonBinding = `{ "action": { "type": "${DIRECT_CREATE_KIND}" } }`;
    const tsBinding = `bind({ target: '${DIRECT_CREATE_TOOL}', kind: 'x' })`;
    expect(findDirectCreateTriggers(yamlBinding, "a.yaml")).toHaveLength(1);
    expect(findDirectCreateTriggers(jsonBinding, "a.json")).toHaveLength(1);
    expect(findDirectCreateTriggers(tsBinding, "a.ts")).toHaveLength(1);
  });

  it("passes the operation-first binding shape (negative control)", () => {
    const operationBinding =
      'action: { type: "blueprint-operation", operationHarnessSlug: "crm", operationId: "lead-qualification" }';
    expect(findDirectCreateTriggers(operationBinding, "a.ts")).toEqual([]);
  });
});

describe.skipIf(!section)("operation-first-triggers", () => {
  it("no trigger in the app's source creates agent work directly", () => {
    const findings: string[] = [];
    for (const file of walk(appRoot!)) {
      findings.push(...findDirectCreateTriggers(readFileSync(file, "utf8"), relative(appRoot!, file)));
    }
    expect(
      findings,
      "agent tasks must be blueprint operations submitted through the seam client " +
        '(action { type: "blueprint-operation", operationHarnessSlug, operationId }), never a direct create',
    ).toEqual([]);
  });

  it("every agent-execution operation's role is declared in the root blueprint", () => {
    const doc = parse(readFileSync(inApp(section!.rootBlueprint ?? ".papercusp/blueprint.yaml"), "utf8")) as {
      roles?: Array<{ id?: string }>;
      operations?: Array<{ id?: string; execution?: { kind?: string; role?: string } }>;
    };
    const declared = new Set((doc.roles ?? []).map((role) => role.id));
    const undeclared = (doc.operations ?? [])
      .filter((operation) => operation.execution?.kind === "agent")
      .filter((operation) => !declared.has(operation.execution?.role))
      .map((operation) => `${operation.id} -> ${operation.execution?.role}`);
    expect(undeclared, "declare each worker role in the root blueprint's roles[] (D-003)").toEqual([]);
  });
});
