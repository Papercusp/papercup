/**
 * THE WIRING GUARD: every ctx key an action module READS must be SUPPLIED by
 * the one place that builds a ChatActionContext.
 *
 * This is the sibling of barrel-registration.test.ts, for the failure one layer
 * in. That guard catches an axis that was never imported, so its control never
 * appears. This one catches an axis that IS registered and DOES render — and
 * reads a ctx key nobody plumbs, so it renders a confident WRONG value.
 *
 * That is worse than an absent control, and it has now happened at least twice
 * in this directory:
 *
 *   - EI-20207719407463922: `compactionLimit` was never added to
 *     SessionChatModal's actionCtx, so the CTX pill read `undefined` and
 *     rendered "auto — no explicit limit is set" for EVERY session, including
 *     ones with a real stored 400000. The control worked; it reported that it
 *     had not.
 *   - EI-20209690740975295: `ompThreadId` and `pid` are declared on
 *     SessionActionCtx as "supplied by SessionChatModal from the SAME
 *     advRoster.list entry" and were not, so /adv/sessions/focus lost one of
 *     its three window identifiers and an omp session with no resolved Claude
 *     transcript id silently offered no Resume.
 *
 * Every per-axis suite is blind to this by construction: a unit test hands the
 * axis a ctx object it built ITSELF, so `current()` reads the key the test
 * supplied and passes whether or not the app supplies it. Nothing short of
 * comparing the two SITES can see the gap — which is what this does, from the
 * directory, so a new axis is covered by existing on disk rather than by its
 * author remembering this file.
 *
 * Both sides are DERIVED, never listed here. A hand-maintained list of keys
 * would rot in exactly the direction that hides the bug: nobody updates it when
 * they add the read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIR = __dirname;

/** The ONE production construction site for a ChatActionContext. */
const CTX_SITE = join(
  DIR,
  '..',
  '..',
  'app',
  '_components',
  'chat',
  'SessionChatModal.tsx',
);

/**
 * Keys the SUBSTRATE guarantees rather than the ctx site: they are required
 * fields on `ChatActionContext` itself, so TypeScript already fails a site that
 * omits them and this guard would be asserting what the compiler asserts.
 */
const SUBSTRATE_KEYS = new Set(['sessionOwnerId', 'ownerLabel']);

/**
 * Strip comments so a key merely DISCUSSED in prose is not read as a key the
 * code consumes. types.ts's header, for instance, contrasts this vocabulary
 * with an agent-initiated card's `ctx.askUser` — a different ctx entirely, and
 * a guard that scanned comments would demand SessionChatModal supply it.
 *
 * `://` is spared so a URL inside a string literal survives.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** Every ctx key the action modules on disk actually read. */
export function ctxKeysRead(files: { name: string; src: string }[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const { name, src } of files) {
    const code = stripComments(src);
    const keys = new Set<string>();
    /* Two idioms, both in live use: a typed read (`ctx.windowId`, via a
       ChatActionContext extension interface) and the cast read
       (`(ctx as { compactionLimit?: unknown }).compactionLimit`) an axis uses
       when it does not want to widen a shared type for one field. */
    for (const m of code.matchAll(/\bctx\s*\.\s*([A-Za-z_]\w*)/g)) keys.add(m[1]);
    for (const m of code.matchAll(/\bctx\s+as\s+\{\s*([A-Za-z_]\w*)/g)) keys.add(m[1]);
    for (const k of keys) {
      if (SUBSTRATE_KEYS.has(k)) continue;
      byKey.set(k, [...(byKey.get(k) ?? []), name]);
    }
  }
  return byKey;
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!('name' in property) || property.name == null) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return null;
}

/** The keys the actionCtx object literal supplies. */
export function ctxKeysSupplied(modalSrc: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    'SessionChatModal.tsx',
    modalSrc,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let declaration: ts.VariableDeclaration | null = null;
  const findDeclaration = (node: ts.Node): void => {
    if (
      declaration == null &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'actionCtx'
    ) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, findDeclaration);
  };
  findDeclaration(sourceFile);

  if (declaration == null) {
    throw new Error(
      'actionCtx no longer exists in SessionChatModal — if the ctx construction ' +
        'site MOVED, point CTX_SITE at the new one rather than deleting this guard.',
    );
  }

  let literal: ts.ObjectLiteralExpression | null = null;
  const findLiteral = (node: ts.Node): void => {
    if (literal != null) return;
    if (ts.isObjectLiteralExpression(node)) {
      const names = new Set(node.properties.map(objectPropertyName).filter(Boolean));
      if (names.has('sessionOwnerId') && names.has('ownerLabel')) {
        literal = node;
        return;
      }
    }
    ts.forEachChild(node, findLiteral);
  };
  findLiteral(declaration);

  const foundLiteral = literal as ts.ObjectLiteralExpression | null;
  if (foundLiteral == null) {
    throw new Error(
      'actionCtx exists but its SessionChatModal object literal was not found — ' +
        'update this guard to follow the production construction site.',
    );
  }

  return new Set(
    foundLiteral.properties.map(objectPropertyName).filter((name): name is string => name != null),
  );
}

function actionModules(): { name: string; src: string }[] {
  return readdirSync(DIR)
    .filter((f) => /\.ts$/.test(f) && !f.includes('.test.'))
    .map((f) => ({ name: f, src: readFileSync(join(DIR, f), 'utf8') }));
}

describe('chat-action ctx wiring', () => {
  it('supplies EVERY ctx key the action modules read', () => {
    const read = ctxKeysRead(actionModules());
    const supplied = ctxKeysSupplied(readFileSync(CTX_SITE, 'utf8'));

    /* Fail with the READERS named: the fix is in whichever axis reads it, and
       an unnamed key sends the next author grepping. */
    const missing = [...read.entries()]
      .filter(([k]) => !supplied.has(k))
      .map(([k, readers]) => `${k} (read by ${readers.join(', ')})`);

    expect(missing, 'ctx keys read by an action but never supplied by SessionChatModal').toEqual(
      [],
    );
  });

  it('reads a non-trivial number of keys (the scan is not silently empty)', () => {
    /* Calibration. Both halves of the assertion above are derived by regex, and
       a regex that matches nothing produces a passing test that checks nothing —
       the exact shape of a guard that "has never failed". */
    expect(ctxKeysRead(actionModules()).size).toBeGreaterThanOrEqual(5);
    expect(ctxKeysSupplied(readFileSync(CTX_SITE, 'utf8')).size).toBeGreaterThanOrEqual(5);
  });

  it('WOULD fail if a read key were unsupplied (falsifiability control)', () => {
    const read = ctxKeysRead([
      { name: 'PhantomAction.ts', src: 'const x = ctx.aKeyNobodySupplies;' },
    ]);
    expect([...read.keys()]).toContain('aKeyNobodySupplies');
    expect(ctxKeysSupplied(readFileSync(CTX_SITE, 'utf8')).has('aKeyNobodySupplies')).toBe(false);
  });

  it('reads the full object across nested ternaries and shorthand properties', () => {
    const supplied = ctxKeysSupplied(`
      const actionCtx = useMemo(
        () => sessionOwnerId
          ? {
              sessionOwnerId,
              ownerLabel,
              agent: roster?.agent ?? null,
              sessionId: sourceKind === 'claude' ? resolved?.sessionId : null,
              modes: roster?.modes ?? [],
              accountPin: roster?.accountPin,
              metadata: { nested: true },
            }
          : null,
        [sessionOwnerId, roster, resolved],
      );
    `);

    expect([...supplied]).toEqual([
      'sessionOwnerId',
      'ownerLabel',
      'agent',
      'sessionId',
      'modes',
      'accountPin',
      'metadata',
    ]);
  });

  it('ignores a key that only appears in a comment', () => {
    const read = ctxKeysRead([
      {
        name: 'CommentOnly.ts',
        src: '/** contrast with an agent card\'s `ctx.askUser`. */\nconst y = 1;\n// see ctx.legacyField\n',
      },
    ]);
    expect([...read.keys()]).toEqual([]);
  });
});
