// @vitest-environment node
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedCorpusBeyondCap } from "@papercusp/operator-core/lib/sync-resolver/count-contract-testkit";
import {
  COUNT_SURFACE_DECLARATIONS,
  UNARMED_COUNT_BEHAVIOR_BASELINE,
} from "./count-surface-contract";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)
    ) {
      out.push(path);
    }
  }
  return out;
}

interface FilterCall {
  file: string;
  line: number;
  declaresEvidence: boolean;
}

function findProductionFilterCalls(): FilterCall[] {
  const files = [
    ...sourceFiles(join(ROOT, "apps/operator/app")),
    ...sourceFiles(join(ROOT, "apps/operator-vite/src")),
  ];
  const calls: FilterCall[] = [];
  for (const file of files) {
    if (file.endsWith("/harness/filters/useColumnFilters.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("useColumnFilters")) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useColumnFilters"
      ) {
        const opts = node.arguments[2];
        const declaresEvidence =
          opts !== undefined &&
          ts.isObjectLiteralExpression(opts) &&
          opts.properties.some((property) => {
            if (ts.isShorthandPropertyAssignment(property))
              return property.name.text === "countEvidence";
            return (
              ts.isPropertyAssignment(property) &&
              ((ts.isIdentifier(property.name) &&
                property.name.text === "countEvidence") ||
                (ts.isStringLiteral(property.name) &&
                  property.name.text === "countEvidence"))
            );
          });
        calls.push({
          file: relative(ROOT, file).replaceAll("\\", "/"),
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          declaresEvidence,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

describe("bounded count surface declaration + behavior ratchet (P-003)", () => {
  it("projects every audited matrix row onto a unique, live source declaration", () => {
    const ids = COUNT_SURFACE_DECLARATIONS.map((surface) => surface.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(19);
    for (const surface of COUNT_SURFACE_DECLARATIONS) {
      expect(surface.sourcePaths.length, surface.id).toBeGreaterThan(0);
      for (const path of surface.sourcePaths) {
        expect(existsSync(join(ROOT, path)), `${surface.id}: ${path}`).toBe(
          true,
        );
      }
      if (
        surface.classification === "active-defect" ||
        surface.classification === "latent-defect"
      ) {
        expect(surface.pageCap, `${surface.id} pageCap`).toBeGreaterThan(0);
      }
      if (surface.behaviorGuard) {
        expect(
          existsSync(join(ROOT, surface.behaviorGuard.testPath)),
          surface.id,
        ).toBe(true);
      }
      if (surface.classification === "control") {
        expect(
          surface.regressionGuardPaths?.length,
          `${surface.id} no-change coverage`,
        ).toBeGreaterThan(0);
        for (const path of surface.regressionGuardPaths ?? []) {
          expect(existsSync(join(ROOT, path)), `${surface.id}: ${path}`).toBe(
            true,
          );
        }
      }
    }
  });

  it("rejects every undeclared production useColumnFilters call and every call without explicit evidence", () => {
    const expected = new Map<string, number>();
    for (const surface of COUNT_SURFACE_DECLARATIONS) {
      for (const [path, count] of Object.entries(
        surface.columnFilterCalls ?? {},
      )) {
        expected.set(path, (expected.get(path) ?? 0) + count);
      }
    }
    const calls = findProductionFilterCalls();
    const actual = new Map<string, number>();
    for (const call of calls) {
      actual.set(call.file, (actual.get(call.file) ?? 0) + 1);
      expect(call.declaresEvidence, `${call.file}:${call.line}`).toBe(true);
    }
    expect(Object.fromEntries([...actual].sort())).toEqual(
      Object.fromEntries([...expected].sort()),
    );
  });

  it("keeps unarmed domain behavior a shrink-only exact baseline", () => {
    const live = COUNT_SURFACE_DECLARATIONS.filter(
      (surface) =>
        (surface.classification === "active-defect" ||
          surface.classification === "latent-defect") &&
        !surface.behaviorGuard,
    )
      .map((surface) => surface.id)
      .sort();
    expect(live).toEqual([...UNARMED_COUNT_BEHAVIOR_BASELINE].sort());
  });

  it("P-014 leaves no audited bounded-array count without corpus, window, or control evidence", () => {
    expect(UNARMED_COUNT_BEHAVIOR_BASELINE).toEqual([]);
    for (const surface of COUNT_SURFACE_DECLARATIONS) {
      if (
        surface.classification === "active-defect" ||
        surface.classification === "latent-defect"
      ) {
        expect(surface.evidence, surface.id).toBe("corpus");
        expect(surface.behaviorGuard, surface.id).toBeDefined();
      } else if (surface.classification === "window-disclosure") {
        expect(surface.evidence, surface.id).toBe("window");
        expect(surface.behaviorGuard, surface.id).toBeDefined();
      } else {
        expect(surface.regressionGuardPaths?.length, surface.id).toBeGreaterThan(0);
      }
    }
  });

  it("seeds every unarmed domain beyond its real configured cap", () => {
    for (const id of UNARMED_COUNT_BEHAVIOR_BASELINE) {
      const surface = COUNT_SURFACE_DECLARATIONS.find(
        (entry) => entry.id === id,
      )!;
      const seeded = seedCorpusBeyondCap({
        pageCap: surface.pageCap!,
        makeRow: (index) => ({ id: `${id}:${index}`, target: false }),
        makeBeyondPageRow: (index) => ({ id: `${id}:${index}`, target: true }),
      });
      expect(seeded.rows.length, id).toBeGreaterThan(surface.pageCap!);
      expect(
        seeded.rows.indexOf(seeded.beyondPageRow),
        id,
      ).toBeGreaterThanOrEqual(surface.pageCap!);
    }
  });
});
