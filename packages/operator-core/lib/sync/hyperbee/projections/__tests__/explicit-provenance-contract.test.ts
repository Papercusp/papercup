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
});
