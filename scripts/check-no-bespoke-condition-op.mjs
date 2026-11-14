#!/usr/bin/env node
/** P-017: THREE distinct comparison literals in a switch or same-subject if
 * dispatch. Consecutive early-return if statements count as one dispatch too.
 * This broad ratchet is separate from the zero-dispatch post-migration check.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { listFilesIncludingUntracked } from './lib/tracked-files.mjs';
import { judgeSites } from './lib/shrink-only-guard.mjs';
import { CONDITION_OPERATORS, operatorDispatches, parseShapeSource } from '../packages/operator-core/lib/code-intelligence/condition-op-dispatch.ts';

export const SEED_HASH = '3049a568af43f41a528230c6b53622c2eed54bbdb2fbefc5aeb234f102151091';
export const OPERATORS = CONDITION_OPERATORS;
export const inScope = (file) => /\.[cm]?[jt]sx?$/.test(file) &&
  !file.startsWith('libs/generic/rules/') &&
  !/(?:^|\/)(?:node_modules|dist[^/]*|build|_retired|env-sidecars|spa|\.next|\.papercusp)\//.test(file) &&
  !/\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts');

export function findDispatches(source, file, threshold = 3) {
  if (!inScope(file)) return [];
  return operatorDispatches(parseShapeSource(source, file), source, file, OPERATORS, threshold).map(({ text: _text, ...hit }) => hit);
}

/** R-74 post-migration assertion: NO local comparison dispatch, even one/two
 * literals, plus positive controls for the retained export and shared evaluator.
 * Does not consult the broad guard's baseline or allowlist.
 */
export function inspectMigratedCaller(source, file, exportName, sharedName) {
  const errors = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let exported = false;
  let sharedCall = false;
  const walk = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === exportName && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exported = true;
    if (ts.isCallExpression(node) && node.expression.getText(ast) === sharedName) sharedCall = true;
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (!exported) errors.push(`missing exported caller ${exportName}`);
  if (!sharedCall) errors.push(`missing shared call ${sharedName}`);
  if (findDispatches(source, file, 1).length) errors.push('local condition dispatch remains');
  return errors;
}

export function main(argv = process.argv.slice(2)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sourceIndex = argv.indexOf('--source');
  const asIndex = argv.indexOf('--as');
  if ((sourceIndex >= 0) !== (asIndex >= 0)) throw new Error('--source requires --as');
  const sites = sourceIndex >= 0
    ? findDispatches(readFileSync(argv[sourceIndex + 1], 'utf8'), argv[asIndex + 1])
    : listFilesIncludingUntracked(root).files.filter(inScope).flatMap((file) => findDispatches(readFileSync(resolve(root, file), 'utf8'), file));
  if (argv.includes('--list')) { console.log(JSON.stringify(sites, null, 2)); return 0; }
  const policy = JSON.parse(readFileSync(new URL('./no-bespoke-condition-op-baseline.json', import.meta.url), 'utf8'));
  const { errors, offenders } = judgeSites(sites, policy, SEED_HASH);
  for (const error of errors) console.error(error);
  for (const site of offenders) console.error(`${site.file}:${site.line}: bespoke condition ${site.shape} (${site.literals.join(', ')}): use @papercusp/rules`);
  if (!errors.length && !offenders.length) console.log(`no-bespoke-condition-op: PASS (${sites.length} measured dispatches)`);
  return errors.length || offenders.length ? 1 : 0;
}
if (isCliEntry(import.meta.url)) process.exitCode = main();
