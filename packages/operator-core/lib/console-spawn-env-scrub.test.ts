/**
 * EI-19407722209410974 — the recurrence guard for the defect that survived its
 * own fix.
 *
 * EI-19385011811175105: an operator started by `npm run dev` from a
 * gnome-terminal tab carries that tab's `GNOME_TERMINAL_SCREEN`. Handed to a new
 * `gnome-terminal`, it asks the D-Bus factory for a screen that is long gone,
 * prints "Failed to get screen from object path ...", and EXITS 0 having opened
 * NO window — a zero-window launch reported as success. That fix landed in
 * `terminal-spawn.ts`... and missed `console-spawn.ts`, which keeps its OWN
 * LINUX_TERMINALS table, its own findTerminal and its own spawn, and which
 * serves the busier callers (capability:terminal, and every VISIBLE
 * fleet:launch-on-plan member).
 *
 * ── Why this is a SOURCE-LEVEL test and not a behavioural one ────────────────
 * The failure mode is not "the existing spawner regressed" — it is "somebody
 * added ANOTHER spawner and did not know this rule existed". A behavioural test
 * can only cover the call sites it already knows about, which is precisely the
 * blind spot that let this bug survive a fix aimed directly at it. Scanning the
 * source catches the fourth spawner the day it is written, before anyone has to
 * rediscover the D-Bus error message.
 *
 * The rule: in these files, a spawned child's env may never be built from a bare
 * `...process.env` spread. It must go through `scrubTerminalContextEnv`, which
 * drops the terminal/multiplexer identity of whatever tab THIS process was
 * started in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TERMINAL_CONTEXT_ENV_KEYS, scrubTerminalContextEnv } from './terminal-spawn';

const FILES = ['console-spawn.ts', 'terminal-spawn.ts'] as const;

function source(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8');
}

type SpawnEnvSite = { line: number; expression: ts.Expression | undefined };

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function spawnEnvSites(file: string): { sourceFile: ts.SourceFile; sites: SpawnEnvSite[] } {
  const sourceFile = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites: SpawnEnvSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'spawn') {
      const options = node.arguments[2];
      const envProperty = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && propertyName(property.name) === 'env',
          )
        : undefined;
      sites.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        expression: envProperty?.initializer,
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { sourceFile, sites };
}

function containsScrubCall(node: ts.Node): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'scrubTerminalContextEnv'
  ) {
    return true;
  }
  return node.getChildren().some(containsScrubCall);
}

function isScrubbedEnv(expression: ts.Expression, sourceFile: ts.SourceFile, visited = new Set<string>()): boolean {
  if (containsScrubCall(expression)) return true;
  if (!ts.isIdentifier(expression) || visited.has(expression.text)) return false;

  visited.add(expression.text);
  let initializer: ts.Expression | undefined;
  function findInitializer(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === expression.text &&
      node.initializer
    ) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, findInitializer);
  }
  findInitializer(sourceFile);
  return initializer ? isScrubbedEnv(initializer, sourceFile, visited) : false;
}

describe('spawned-child env scrub (EI-19407722209410974)', () => {
  for (const file of FILES) {
    it(`${file}: every child spawn passes an env scrubbed by scrubTerminalContextEnv`, () => {
      const { sourceFile, sites } = spawnEnvSites(file);
      expect(sites.length, `${file} should retain at least one audited child spawn`).toBeGreaterThan(0);
      for (const site of sites) {
        expect(
          site.expression && isScrubbedEnv(site.expression, sourceFile),
          `${file}:${site.line} child spawn must set env through scrubTerminalContextEnv`,
        ).toBe(true);
      }
    });
  }

  it('console-spawn.ts actually imports the scrub rather than re-implementing it', () => {
    // A local re-implementation would satisfy the regexes above while drifting
    // from TERMINAL_CONTEXT_ENV_KEYS — which is the whole failure mode this
    // family of bugs is made of.
    expect(source('console-spawn.ts')).toMatch(
      /import\s*\{[^}]*scrubTerminalContextEnv[^}]*\}\s*from\s*'\.\/terminal-spawn'/,
    );
  });

  it('the scrub removes the var that caused the zero-window launch', () => {
    // Ties the source-level rule to the concrete behaviour it protects, so this
    // file still fails if the key set is gutted while the call sites stay.
    const out = scrubTerminalContextEnv({
      PATH: '/usr/bin',
      DISPLAY: ':1',
      GNOME_TERMINAL_SCREEN: '/org/gnome/Terminal/screen/f7136bff_f487_4330_8ff5_966041ee694a',
    });
    expect(out.GNOME_TERMINAL_SCREEN).toBeUndefined();
    expect(out.DISPLAY).toBe(':1');
    expect(TERMINAL_CONTEXT_ENV_KEYS).toContain('GNOME_TERMINAL_SCREEN');
  });

  it('the scrub removes operator-only sidecar toggles before launching agents', () => {
    // These flags tune git offload inside the operator service itself. If they
    // cross the operator→agent boundary, an unrelated agent-shell test can
    // route through the degraded spawner sidecar and emit a console warning
    // (WI-37487). Keep the assertion on the shared scrub, not one caller, so
    // visible, macOS, and headless spawn paths all inherit the same guard.
    const out = scrubTerminalContextEnv({
      PATH: '/usr/bin',
      PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR: '1',
      PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '1',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3170',
    });
    expect(out.PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR).toBeUndefined();
    expect(out.PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR).toBeUndefined();
    expect(out.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:3170');
    expect(TERMINAL_CONTEXT_ENV_KEYS).toEqual(
      expect.arrayContaining([
        'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR',
        'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR',
      ]),
    );
  });
});
