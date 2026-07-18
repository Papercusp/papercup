/**
 * no-org-pool-sql-json.js — ESLint rule (EI-10445).
 *
 * `sql.json(value)` (and a bare object param) THROWS under every canonical
 * db-org client — `getOrgPg()` / `getOrgPgApp()` / `getHarnessPg()`, all built
 * by the SAME `buildClient` in libs/papercusp/libs/db/src/connection.ts
 * (prepare:false mis-binds the postgres-js json helper there):
 *
 *   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type
 *   string or an instance of Buffer or ArrayBuffer. Received an instance of
 *   Object
 *
 * This has bitten silently in fail-soft code more than once (EI-10445: a
 * loops-panel collector stuck on "unknown", a health-history writer that
 * wrote 0 rows for hours) because a `.catch(() => fallback)` around the query
 * eats the throw. At least a dozen files independently rediscovered this and
 * left their own tribal-knowledge comment ("NOT sql.json() — the org pool
 * throws…") instead of a mechanical guard — see
 * agent-insights/postgres-js-jsonb-binding for the full writeup and the
 * canonical fix: bind jsonb as `${JSON.stringify(value)}::text::jsonb`.
 *
 * IMPORTANT — this is NOT a blanket ban on `sql.json()`. A DIFFERENT pool
 * (e.g. `packages/operator-core/lib/dock-layouts.ts`'s own fresh
 * `postgres()` client) has the OPPOSITE behavior: `sql.json()` is CORRECT
 * there and `${JSON.stringify}::jsonb` double-encodes. So this rule only
 * fires in a file that imports one of the throwing db-org accessors
 * (`getOrgPg` / `getOrgPgApp` / `getHarnessPg`) from `@papercusp/db-org` —
 * a file using a different pool is never flagged.
 *
 * Sibling of `no-bare-jsonb-cast.js` (same problem class, opposite form —
 * that rule autofixes a bare `${x}::jsonb`; this one only DETECTS a
 * `sql.json(x)` call, since rewriting it into the tagged-template convention
 * needs to know the surrounding cast text and isn't safely mechanical).
 *
 * Wire-up (eslint.config.mjs):
 *   { plugins: { papercusp: rules }, rules: { 'papercusp/no-org-pool-sql-json': 'error' } }
 */

'use strict';

const DB_ORG_PACKAGE = '@papercusp/db-org';
const THROWING_ACCESSORS = new Set(['getOrgPg', 'getOrgPgApp', 'getHarnessPg']);

/** True for a `sql.json(x)` / `tx.json(x)` / `<anything>.json(x)` call —
 *  mirrors no-bare-jsonb-cast.js's isJsonHelperCall member-expression leg
 *  (this rule intentionally does NOT also match a bare `pgJson(...)` free
 *  function — that helper is a distinct, already-safe wrapper, not the
 *  postgres-js `sql.json` method this rule targets). */
function isSqlJsonMemberCall(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  return callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && callee.property.name === 'json';
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'sql.json(x) throws under getOrgPg/getOrgPgApp/getHarnessPg (prepare:false mis-binds it) — bind jsonb as ${JSON.stringify(x)}::text::jsonb instead.',
    },
    schema: [],
    messages: {
      throws:
        '`{{expr}}.json(...)` throws under the db-org pool imported in this file (getOrgPg/getOrgPgApp/getHarnessPg — prepare:false mis-binds it; a .catch() around the query silently eats the failure). Bind jsonb as `${JSON.stringify(value)}::text::jsonb` instead — see agent-insights/postgres-js-jsonb-binding.',
    },
  },
  create(context) {
    let usesThrowingPool = false;
    const candidates = []; // sql.json(...)-shaped CallExpression nodes seen during the normal traversal

    function checkImportSource(source, specifiers) {
      if (source !== DB_ORG_PACKAGE) return;
      for (const name of specifiers) {
        if (THROWING_ACCESSORS.has(name)) {
          usesThrowingPool = true;
          return;
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const names = node.specifiers
          .filter((s) => s.type === 'ImportSpecifier')
          .map((s) => (s.imported && s.imported.name) || s.local.name);
        checkImportSource(node.source.value, names);
      },
      // `const { getOrgPg } = await import('@papercusp/db-org')` — the
      // dynamic-import destructure form used by a few lazy-loaded call sites
      // (e.g. system-health/liveness-alarm.ts).
      VariableDeclarator(node) {
        if (
          node.init &&
          node.init.type === 'AwaitExpression' &&
          node.init.argument.type === 'ImportExpression' &&
          node.init.argument.source.type === 'Literal' &&
          node.id.type === 'ObjectPattern'
        ) {
          const names = node.id.properties
            .filter((p) => p.type === 'Property' && p.key.type === 'Identifier')
            .map((p) => p.key.name);
          checkImportSource(node.init.argument.source.value, names);
        }
      },
      // Collected via ESLint's own traversal (not a hand-rolled re-walk) —
      // whether to actually REPORT depends on `usesThrowingPool`, which may
      // only be known once the whole file (incl. a later dynamic import) has
      // been visited, so reporting is deferred to Program:exit below.
      CallExpression(node) {
        if (isSqlJsonMemberCall(node)) candidates.push(node);
      },
      'Program:exit'() {
        if (!usesThrowingPool) return;
        const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
        for (const node of candidates) {
          context.report({
            node,
            messageId: 'throws',
            data: { expr: sourceCode.getText(node.callee.object) },
          });
        }
      },
    };
  },
};
