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

/** True for a `.json(x)` member call. The receiver is checked separately once
 *  the complete binding graph is available at `Program:exit` — a file may
 *  contain both a throwing SQL client and unrelated Response/request objects.
 */
function isSqlJsonMemberCall(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  return callee.type === 'MemberExpression' && callee.property.type === 'Identifier' && callee.property.name === 'json';
}

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'AwaitExpression' ||
      current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TypeCastExpression')
  ) {
    current = current.type === 'AwaitExpression' ? current.argument : current.expression;
  }
  return current;
}

function staticPropertyName(node) {
  const property = unwrapExpression(node);
  if (!property) return null;
  if (property.type === 'Identifier') return property.name;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  return null;
}

function bindingIdentifier(node) {
  const pattern = unwrapExpression(node);
  if (pattern?.type === 'Identifier') return pattern;
  if (pattern?.type === 'AssignmentPattern') return bindingIdentifier(pattern.left);
  return null;
}

function isMemberNamed(node, name) {
  const expression = unwrapExpression(node);
  return (
    expression &&
    expression.type === 'MemberExpression' &&
    !expression.computed &&
    staticPropertyName(expression.property) === name
  );
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
    const throwingAccessorBindings = new Set();
    const dbOrgNamespaceBindings = new Set();
    const sqlBindings = new Set();
    const handleBindings = new Set();
    const candidates = []; // sql.json(...)-shaped CallExpression nodes seen during the normal traversal

    function checkImportSource(source, specifiers) {
      if (source !== DB_ORG_PACKAGE) return;
      for (const specifier of specifiers) {
        if (specifier.kind === 'namespace') {
          dbOrgNamespaceBindings.add(specifier.local);
          continue;
        }
        if (THROWING_ACCESSORS.has(specifier.imported)) {
          throwingAccessorBindings.add(specifier.local);
        }
      }
    }

    function isThrowingAccessorReference(node) {
      const reference = unwrapExpression(node);
      if (!reference) return false;
      if (reference.type === 'Identifier') return throwingAccessorBindings.has(reference.name);
      return (
        reference.type === 'MemberExpression' &&
        !reference.computed &&
        reference.object.type === 'Identifier' &&
        dbOrgNamespaceBindings.has(reference.object.name) &&
        THROWING_ACCESSORS.has(staticPropertyName(reference.property))
      );
    }

    function isThrowingAccessorCall(node) {
      const call = unwrapExpression(node);
      return call?.type === 'CallExpression' && isThrowingAccessorReference(call.callee);
    }

    function isHandleExpression(node) {
      const expression = unwrapExpression(node);
      if (!expression) return false;
      if (expression.type === 'Identifier') return handleBindings.has(expression.name);
      return isThrowingAccessorCall(expression);
    }

    function isSqlClientExpression(node) {
      const expression = unwrapExpression(node);
      if (!expression) return false;
      if (expression.type === 'Identifier') return sqlBindings.has(expression.name);
      return isMemberNamed(expression, 'sql') && isHandleExpression(expression.object);
    }

    function registerDestructuredBindings(pattern, init) {
      if (pattern.type !== 'ObjectPattern' || !isThrowingAccessorCall(init)) return;
      for (const property of pattern.properties) {
        if (property.type !== 'Property' || property.computed) continue;
        const importedName = staticPropertyName(property.key);
        const local = bindingIdentifier(property.value);
        if (importedName === 'sql' && local) sqlBindings.add(local.name);
        if (importedName === 'sql' && property.value.type === 'AssignmentPattern') sqlBindings.add(local.name);
      }
    }

    function registerVariableBinding(node) {
      const local = bindingIdentifier(node.id);
      if (!local) {
        registerDestructuredBindings(node.id, node.init);
        return;
      }

      const init = unwrapExpression(node.init);
      if (isThrowingAccessorCall(init)) {
        // All three accessors return a handle object. Its `.sql` property is
        // tracked below. Keep the direct accessor binding in the SQL set too:
        // older call sites treat the accessor's direct return as the client,
        // and the rule must continue to catch that form while handling the
        // canonical `.sql` member form precisely.
        handleBindings.add(local.name);
        sqlBindings.add(local.name);
        return;
      }
      if (isSqlClientExpression(init)) {
        sqlBindings.add(local.name);
      }
    }

    function registerDynamicImport(node) {
      const init = unwrapExpression(node.init);
      const importExpression = init?.type === 'ImportExpression' ? init : null;
      if (!importExpression || importExpression.source.type !== 'Literal' || importExpression.source.value !== DB_ORG_PACKAGE) {
        return;
      }
      if (node.id.type === 'Identifier') {
        dbOrgNamespaceBindings.add(node.id.name);
        return;
      }
      if (node.id.type !== 'ObjectPattern') return;
      for (const property of node.id.properties) {
        if (property.type !== 'Property' || property.computed) continue;
        const importedName = staticPropertyName(property.key);
        const local = bindingIdentifier(property.value);
        if (local && THROWING_ACCESSORS.has(importedName)) throwingAccessorBindings.add(local.name);
      }
    }

    return {
      ImportDeclaration(node) {
        checkImportSource(
          node.source.value,
          node.specifiers.map((specifier) => {
            if (specifier.type === 'ImportNamespaceSpecifier') {
              return { kind: 'namespace', local: specifier.local.name };
            }
            return {
              kind: 'named',
              imported: staticPropertyName(specifier.imported),
              local: specifier.local.name,
            };
          }),
        );
      },
      // `const { getOrgPg } = await import('@papercusp/db-org')` — the
      // dynamic-import destructure form used by a few lazy-loaded call sites
      // (e.g. system-health/liveness-alarm.ts). Track both destructured
      // accessors and a namespace-style `const dbOrg = await import(...)`.
      VariableDeclarator(node) {
        registerDynamicImport(node);
        registerVariableBinding(node);
      },
      // Collected via ESLint's own traversal (not a hand-rolled re-walk) —
      // whether to actually REPORT depends on `usesThrowingPool`, which may
      // only be known once the whole file (incl. a later dynamic import) has
      // been visited, so reporting is deferred to Program:exit below.
      CallExpression(node) {
        if (isSqlJsonMemberCall(node)) candidates.push(node);
      },
      'Program:exit'() {
        const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
        for (const node of candidates) {
          if (!isSqlClientExpression(node.callee.object)) continue;
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
