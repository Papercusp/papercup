import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * EI-22075523796704778 — @papercusp/chat-protocol's published sources must use
 * explicit-extension relative specifiers (`./voice.js`, not `./voice`).
 *
 * Why this guard exists, and why it cannot live in chat-protocol itself:
 *
 * That package's `exports` map points at RAW TypeScript source
 * (`./src/index.ts`), so each consumer type-checks our source under THEIR
 * `moduleResolution`. The strictest is `NodeNext` — used by the standalone
 * Phone worker, which resolves the package through a `file:` link — and
 * NodeNext REJECTS extensionless relative specifiers (TS2835). chat-protocol's
 * own tsconfig uses `moduleResolution: "bundler"`, which PERMITS them, so its
 * `npm run typecheck` structurally cannot catch the breakage; it surfaces only
 * in a separate, out-of-tree consumer, long after the change lands.
 *
 * Measured cost of that gap: on 2026-09-01 `index.ts` carried
 * `export * from './su-session'` / `'./voice'`. Two TS2835 errors emptied the
 * package's public surface, cascading into 19 "missing export" errors in the
 * Phone worker (VOICE_PROTOCOL_VERSION, VoiceTurnEvent, VoiceTurnExecutor, the
 * parsers/serializers). WI-2140385 is the same class against the Portal host.
 *
 * The guard is deliberately NOT repo-wide: 38 of the 64 `libs/generic/*`
 * packages that export raw `.ts` carry 946 extensionless specifiers, and that
 * is CORRECT for the ones consumed only by bundlers. This invariant belongs to
 * packages with a real NodeNext source consumer. chat-protocol is one; add a
 * package here when it gains one, rather than widening to the whole tree.
 *
 * Recurrence risk is live, not theoretical: the pre-fix code carried a comment
 * arguing FOR extensionless ("so bundlers that consume the TypeScript package
 * directly resolve the sibling .ts modules"). That reasoning is plausible and
 * someone will re-apply it — which is exactly what this test is here to catch.
 *
 * It lives in operator-core because operator-core depends on
 * @papercusp/chat-protocol, so the affected-tests graph selects this file
 * whenever chat-protocol's source changes; and because adding @types/node to
 * chat-protocol (needed to read files there) would leak node globals across a
 * package deliberately kept browser-consumable and deps-free — weakening the
 * very strictness this guard adds.
 */

/** Walk up to the checkout root by marker, so the test is invocation-independent. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "libs", "generic", "chat-protocol", "package.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate checkout root from this test file");
}

/**
 * Defaults to the real package. Overridable ONLY so this guard's falsifiability
 * can be proven against a throwaway COPY outside the repo — never mutate the
 * shared tree to test a guard: git-sync sweeps the whole tree on a timer and
 * will commit the mutant even if nothing goes wrong.
 */
const CHAT_PROTOCOL_SRC =
  process.env.CHAT_PROTOCOL_SRC_DIR ?? join(repoRoot(), "libs", "generic", "chat-protocol", "src");

/** Strip comments so prose merely NAMING a specifier cannot false-positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n"'`]*\/\/.*$/gm, "");
}

const RELATIVE_SPECIFIER_RE = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.[^"']*)["']/g;

/**
 * Relative specifiers in `source` lacking an explicit extension. Exported so
 * the controls below exercise the SAME code path as the real assertion — a
 * checker only ever run on passing input is indistinguishable from one that
 * always returns [].
 */
export function findExtensionlessRelativeSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(source).matchAll(RELATIVE_SPECIFIER_RE)) {
    const specifier = match[1];
    if (!/\.(js|json)$/.test(specifier)) found.push(specifier);
  }
  return found;
}

/** Published = shipped to consumers. Test files are consumed only by vitest. */
function publishedSourceFiles(): string[] {
  return readdirSync(CHAT_PROTOCOL_SRC)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts"))
    .sort();
}

describe("chat-protocol published sources are NodeNext-resolvable", () => {
  // ---- Controls: prove the checker can FAIL, not merely return []. ----

  it("FLAGS the exact pre-fix shape that broke the Phone worker", () => {
    const preFix = "export * from './su-session';\nexport * from './voice';";
    expect(findExtensionlessRelativeSpecifiers(preFix)).toEqual(["./su-session", "./voice"]);
  });

  it("accepts the fixed shape and ignores specifiers named only in comments", () => {
    const fixed = [
      "// Historical: this read `export * from './voice'` and broke NodeNext.",
      "/* Also from './su-session' in a block comment. */",
      "export * from './su-session.js';",
      "import { thing } from './deep/nested.js';",
      "import './side-effect.js';",
      "const lazy = await import('./dynamic.js');",
    ].join("\n");
    expect(findExtensionlessRelativeSpecifiers(fixed)).toEqual([]);
  });

  it("does not treat bare package specifiers as relative", () => {
    expect(
      findExtensionlessRelativeSpecifiers("import { z } from 'zod';\nimport { x } from 'node:fs';"),
    ).toEqual([]);
  });

  // ---- The real assertion. ----

  it("scans a non-empty set of published sources", () => {
    // Without this, a bad path would make the assertion below vacuously green.
    expect(publishedSourceFiles()).toContain("index.ts");
  });

  it("every published source uses explicit-extension relative specifiers", () => {
    const violations: string[] = [];
    for (const name of publishedSourceFiles()) {
      for (const spec of findExtensionlessRelativeSpecifiers(
        readFileSync(join(CHAT_PROTOCOL_SRC, name), "utf8"),
      )) {
        violations.push(`${name}: '${spec}' must be '${spec}.js' (NodeNext consumers reject it)`);
      }
    }
    expect(violations).toEqual([]);
  });
});
