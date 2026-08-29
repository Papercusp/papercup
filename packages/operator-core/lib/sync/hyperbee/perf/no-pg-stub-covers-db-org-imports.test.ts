/**
 * The perf peer-child resolves `@papercusp/db-org` to `no-pg-stub.mjs` (see no-pg-hooks.mjs).
 * A named ESM import is bound at INSTANTIATE time, so a name the stub does not export is not a
 * lazy "throws when touched" — it is a hard link error that kills the child before it runs a
 * single line:
 *
 *   SyntaxError: The requested module '@papercusp/db-org' does not provide an export named 'X'
 *
 * The parent (`child-driver.ts`) only ever sees `waitFor('ready')` resolve null after its 30s
 * timeout, and routes the child's stderr into a `logs` array that the failing assertion never
 * prints. So the observable symptom is an opaque timeout and the actual one-line cause is
 * invisible.
 *
 * MEASURED (WI-761481, 2026-08-29): `resource-governor/execution.ts` imports
 * `createDedicatedOrgPg` from `@papercusp/db-org`. The stub exported only `getOrgPg` and `orgPg`,
 * so every perf peer-child died at link time. `child-driver.test.ts` sat red on the
 * green-checkpoint gate as `expected null to match object { evt: 'ready' }` — a 30-second
 * timeout that names nothing — and diagnosing it required booting the child by hand.
 *
 * The stub's export list is therefore a SECOND COPY of a truth the operator-core sources own, and
 * it drifts silently. This guard DERIVES the required set from those sources so a new named
 * import fails HERE, in milliseconds, with the missing name — instead of hours later in the gate
 * as a nameless timeout.
 *
 * SCOPE: `packages/operator-core/lib`, which is the substrate the peer-child boots and the source
 * of the measured break. Over-inclusion is the safe direction — an extra stub binding is inert
 * (tsx erases type-only imports, and an unused runtime binding is never called), while a missing
 * one is fatal — so this deliberately does not try to narrow the scan to the child's exact
 * transitive graph.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as stub from './no-pg-stub.mjs';

const OPERATOR_CORE_LIB = fileURLToPath(new URL('../../../', import.meta.url));

/** Every `{ … }` clause bound against '@papercusp/db-org', import or re-export. */
const DB_ORG_CLAUSE =
  /(?:import|export)\s+(?:type\s+)?(?:[A-Za-z0-9_$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]@papercusp\/db-org['"]/g;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts')) out.push(full);
  }
  return out;
}

/** `type Foo as Bar` / `Foo as Bar` / `Foo` → the name the MODULE must export (`Foo`). */
function importedName(clauseItem: string): string | null {
  const cleaned = clauseItem.trim().replace(/^type\s+/, '');
  if (!cleaned) return null;
  const source = cleaned.split(/\s+as\s+/)[0].trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(source) ? source : null;
}

describe('no-pg-stub covers every @papercusp/db-org named import in the peer-child substrate', () => {
  it('exports every name operator-core binds from @papercusp/db-org', () => {
    const required = new Map<string, string[]>();

    for (const file of tsFilesUnder(OPERATOR_CORE_LIB)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('@papercusp/db-org')) continue;
      for (const match of text.matchAll(DB_ORG_CLAUSE)) {
        for (const item of match[1].split(',')) {
          const name = importedName(item);
          if (!name) continue;
          const seen = required.get(name) ?? [];
          if (seen.length < 3) seen.push(file.slice(OPERATOR_CORE_LIB.length));
          required.set(name, seen);
        }
      }
    }

    // A scan that finds nothing would pass vacuously and guard exactly nothing. The break this
    // exists for is a name the scan DID find; a zero here means the regex or the walk broke.
    expect(required.size).toBeGreaterThan(10);

    const missing = [...required.keys()].filter((name) => !(name in stub)).sort();

    expect(
      missing,
      missing.length === 0
        ? ''
        : `no-pg-stub.mjs is missing ${missing.length} export(s) that operator-core binds from ` +
          `'@papercusp/db-org'. A named ESM import is bound at LINK time, so each of these kills ` +
          `every perf peer-child before it emits a single event — surfacing only as an opaque ` +
          `30s 'expected null to match { evt: ready }' timeout in child-driver.test.ts.\n\n` +
          missing.map((n) => `  ${n}  (e.g. ${required.get(n)!.join(', ')})`).join('\n') +
          `\n\nFix: add \`export const <name> = stub('<name>');\` to no-pg-stub.mjs for each. ` +
          `Do NOT soften the stub to a catch-all — the throwing binding is what keeps a perf run ` +
          `that reaches Postgres from being read as a measurement.`,
    ).toEqual([]);
  });
});
