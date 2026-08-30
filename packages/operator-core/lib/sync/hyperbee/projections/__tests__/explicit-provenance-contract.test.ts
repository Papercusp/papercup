/**
 * WI-41277 / P-507 recurrence guard.
 *
 * Every projection writer must take provenance explicitly. A missing context
 * must never be converted to origin='local': that hides remote rows and can
 * make them eligible for re-emission as locally authored state.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PROJECTIONS_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function productionProjectionFiles(): string[] {
  return readdirSync(PROJECTIONS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.endsWith('.test.ts') && !name.endsWith('.spec.ts'))
    .map((name) => join(PROJECTIONS_DIR, name));
}

describe('explicit projection provenance contract', () => {
  it('requires provenance on every production writer and forbids local origin fallbacks', () => {
    let writerCount = 0;
    const violations: string[] = [];

    for (const file of productionProjectionFiles()) {
      const source = readFileSync(file, 'utf8');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

      for (const statement of parsed.statements) {
        if (!ts.isFunctionDeclaration(statement)) continue;
        const name = statement.name?.text;
        if (name !== 'writeToPg' && name !== 'applyPart') continue;
        writerCount += 1;

        const provenance = statement.parameters.find(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'provenance',
        );
        if (!provenance) {
          violations.push(`${file}: ${name} omits the provenance parameter`);
          continue;
        }
        if (provenance.questionToken || provenance.initializer) {
          violations.push(`${file}: ${name} makes provenance optional/defaulted`);
        }

        const body = statement.body?.getText(parsed) ?? '';
        if (/provenance\s*\?\.\s*origin/.test(body)) {
          violations.push(`${file}: ${name} still treats provenance origin as optional`);
        }
        if (/provenance[^;\n]*\?\?\s*['\"]local['\"]/.test(body)) {
          violations.push(`${file}: ${name} silently defaults missing provenance to local`);
        }
      }
    }

    expect(writerCount).toBeGreaterThanOrEqual(32);
    expect(violations).toEqual([]);
  });

  /**
   * WI-471233 — the same defect class, one function over.
   *
   * The contract above only inspects `writeToPg` / `applyPart`, so the DELETE-AUTHORITY
   * gates were invisible to it. `deleteFromPg` takes provenance as an OPTIONAL 4th arg by
   * design (TableProjection: "deleters that don't author-scope ignore it"), so we cannot
   * simply require it. What we CAN forbid is the WI-41277 shape itself — silently
   * converting an absent context into origin='local' — and we can PIN the population of
   * deleters that fall back to an unscoped delete so a new one cannot appear unnoticed.
   */
  const UNSCOPED_DELETE_ON_ABSENT_PROVENANCE = new Set<string>();

  it('forbids local-origin fallbacks in delete paths and pins the unscoped-delete population', () => {
    const violations: string[] = [];
    const unscoped: string[] = [];
    let authorScopedDeleters = 0;

    for (const file of productionProjectionFiles()) {
      const source = readFileSync(file, 'utf8');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const base = file.slice(file.lastIndexOf('/') + 1);

      for (const statement of parsed.statements) {
        if (!ts.isFunctionDeclaration(statement)) continue;
        if (statement.name?.text !== 'deleteFromPg') continue;

        const takesProvenance = statement.parameters.some(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'provenance',
        );
        // A deleter that does not author-scope is exempt by contract, not by oversight.
        if (!takesProvenance) continue;
        authorScopedDeleters += 1;

        const body = statement.body?.getText(parsed) ?? '';
        if (/provenance[^;\n]*\?\?\s*['"]local['"]/.test(body)) {
          violations.push(`${base}: deleteFromPg silently defaults missing provenance to local`);
        }
        if (/provenance\s*\?\.\s*\w+\s*(?:\?\?|\|\|)\s*null/.test(body)) {
          unscoped.push(base);
        }
      }
    }

    // The four author-scoping deleters today: engineer-issues, gym-qd-elites,
    // harness-plans, presence. If this drops, a delete-authority gate was removed.
    expect(authorScopedDeleters).toBeGreaterThanOrEqual(4);
    expect(violations).toEqual([]);
    expect([...new Set(unscoped)].sort()).toEqual([...UNSCOPED_DELETE_ON_ABSENT_PROVENANCE].sort());
  });
});
