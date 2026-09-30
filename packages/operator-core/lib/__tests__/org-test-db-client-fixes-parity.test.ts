/**
 * WI-10004177: the org test fixture must apply EVERY client fix that production's `buildClient()`
 * applies.
 *
 * `buildClient()` (@papercusp/db-org connection.ts) calls a set of `(client: Sql): void` fixes from
 * raw-serializers.ts on every production client. `applyRawSerializerFixes` in
 * test/_org-test-db.ts is meant to mirror that set. It drifted: WI-41207 and EI-21301868186403490
 * added `seedBuiltinArrayTypes` and `installNumericArrayTyping` to production only. So an
 * integration test's first `sql.array(['a'])` was sent as `text` against a `text[]` column, a
 * failure production never has.
 *
 * This guard DERIVES the required set from the two sources rather than listing it, so the next fix
 * added to `buildClient()` fails here until the fixture applies it too.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERIALIZERS = 'libs/papercusp/libs/db/src/raw-serializers.ts';
const CONNECTION = 'libs/papercusp/libs/db/src/connection.ts';
const FIXTURE = 'packages/operator-core/test/_org-test-db.ts';

/** Body of `function <name>(` up to the first line that is exactly `}`. */
function functionBody(src: string, name: string): string | null {
  const start = src.search(new RegExp(`\\bfunction ${name}\\(`));
  if (start < 0) return null;
  const end = src.indexOf('\n}\n', start);
  return end < 0 ? null : src.slice(start, end);
}

/** Names of every `export function x(client: Sql): void` in raw-serializers. */
function clientFixNames(serializersSrc: string): string[] {
  return [...serializersSrc.matchAll(/^export function (\w+)\(client: Sql\): void/gm)].map((m) => m[1]!);
}

function called(body: string, name: string): boolean {
  return new RegExp(`\\b${name}\\(client\\);`).test(body);
}

interface ParityReport {
  required: string[];
  missingFromFixture: string[];
  problems: string[];
}

function inspectClientFixParity(src: { serializers: string; connection: string; fixture: string }): ParityReport {
  const problems: string[] = [];
  const fixes = clientFixNames(src.serializers);
  if (fixes.length === 0) problems.push(`no \`export function x(client: Sql): void\` found in ${SERIALIZERS}`);
  const build = functionBody(src.connection, 'buildClient');
  if (build === null) problems.push(`buildClient not found in ${CONNECTION}`);
  const fixture = functionBody(src.fixture, 'applyRawSerializerFixes');
  if (fixture === null) problems.push(`applyRawSerializerFixes not found in ${FIXTURE}`);
  const required = build === null ? [] : fixes.filter((name) => called(build, name));
  if (build !== null && required.length === 0) problems.push('buildClient calls none of the raw-serializers client fixes');
  const missingFromFixture = fixture === null ? [] : required.filter((name) => !called(fixture, name));
  return { required, missingFromFixture, problems };
}

const SYNTHETIC = {
  serializers: [
    'export function fixA(client: Sql): void {',
    '}',
    'export function fixB(client: Sql): void {',
    '}',
    'export function unrelated(x: number): void {',
    '}',
  ].join('\n'),
  connection: ['function buildClient(url: string) {', '  fixA(client);', '  fixB(client);', '  return client;', '}', ''].join('\n'),
  fixture: ['function applyRawSerializerFixes(client: Sql): Sql {', '  fixA(client);', '  fixB(client);', '  return client;', '}', ''].join('\n'),
};

describe('org test fixture applies every production client fix (WI-10004177)', () => {
  it('accepts a fixture that applies the full set', () => {
    expect(inspectClientFixParity(SYNTHETIC)).toEqual({ required: ['fixA', 'fixB'], missingFromFixture: [], problems: [] });
  });

  it('names a fix that production applies and the fixture skips', () => {
    const report = inspectClientFixParity({ ...SYNTHETIC, fixture: SYNTHETIC.fixture.replace('  fixB(client);\n', '') });
    expect(report.missingFromFixture).toEqual(['fixB']);
  });

  it('refuses a vacuous pass when the sources cannot be read', () => {
    expect(inspectClientFixParity({ serializers: '', connection: '', fixture: '' }).problems.length).toBeGreaterThan(0);
  });

  it('the live tree: the fixture applies every fix buildClient applies', () => {
    const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
    const report = inspectClientFixParity({ serializers: read(SERIALIZERS), connection: read(CONNECTION), fixture: read(FIXTURE) });
    expect(report.problems).toEqual([]);
    // Positive control: production's known fixes are in the derived set, so an empty or broken
    // derivation cannot pass as "nothing to mirror".
    expect(report.required).toEqual(
      expect.arrayContaining(['restoreRawDateSerializers', 'restoreRawJsonbSerializer', 'seedBuiltinArrayTypes', 'installNumericArrayTyping']),
    );
    expect(report.missingFromFixture).toEqual([]);
  });
});
