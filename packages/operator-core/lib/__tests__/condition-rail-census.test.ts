/** P-017: independent, tracked-tree git-grep census; scanner predicates are not the enumerator. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { isScannable, scanSites } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { stripCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pattern = 'notifyAttention|escalateAlarm|console\\.(warn|error|log|info)|logger\\.(warn|error|info)|LOG\\.(warn|error|info)|log\\.(warn|error|info)|managedSetInterval|waiver[[:space:]]*:|(alarm|alarming|alert|alerting|degraded|unhealthy|breached)[[:space:]]*:';

it('accounts for independently grepped signal tokens as sites or reasoned exclusions', () => {
  const output = execFileSync('git', ['grep', '--recurse-submodules', '-n', '-E', pattern, '--', 'packages', 'apps', 'orchestrator', 'bin', 'scripts', 'libs'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const files = new Map<string, Set<number>>();
  for (const line of output.split('\n')) {
    const hit = line.match(/^(.+?):(\d+):/);
    if (!hit) continue;
    const lines = files.get(hit[1]) ?? new Set<number>();
    lines.add(Number(hit[2]));
    files.set(hit[1], lines);
  }
  expect(files.size).toBeGreaterThan(0);
  const missing: string[] = [];
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  for (const [file, lines] of files) {
    if (!isScannable(file)) { exclude('test, generated, vendored, retired, declaration, or non-source path'); continue; }
    const raw = readFileSync(resolve(root, file), 'utf8');
    const masked = stripCommentsAndStrings(raw, file);
    const maskedLines = masked.split('\n');
    const sites = scanSites(raw, file);
    const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
    const calls = new Map<number, string[]>();
    const fallbacks = new Map<number, number>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const names = calls.get(line) ?? [];
        names.push(name);
        calls.set(line, names);
        if (ts.isPropertyAccessExpression(expression) &&
            /^(?:console|logger|LOG|log)$/.test(expression.expression.getText(sf)) &&
            /^(?:warn|error|log|info)$/.test(expression.name.text) &&
            /fall(?:ing|s)?[ -]?back|fail(?:ing|s)?[ -]?open|fail(?:ed|ing)? open|degrad(?:ed|ing) to/i.test(node.arguments.map((arg) => arg.getText(sf)).join(' '))) {
          fallbacks.set(line, (fallbacks.get(line) ?? 0) + 1);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const line of lines) {
      const alarmCalls = (calls.get(line) ?? []).filter((name) => ['notifyAttention', 'notifyAttentionOnce', 'escalateAlarm'].includes(name));
      const alarmSites = sites.filter((site) => site.line === line && site.class === 'owner-only-alarm');
      if (alarmCalls.length > alarmSites.length) missing.push(`${file}:${line}: live owner-alarm call omitted`);
      const fallbackCalls = fallbacks.get(line) ?? 0;
      const fallbackSites = sites.filter((site) => site.line === line && site.class === 'log-only-fallback');
      if (fallbackCalls > fallbackSites.length) missing.push(`${file}:${line}: live fallback log omitted`);
      if (sites.some((site) => site.line === line)) continue;
      const code = maskedLines[line - 1] ?? '';
      if (!/notifyAttention|escalateAlarm|console\.|logger\.|LOG\.|log\.|managedSetInterval|waiver|alarm|alert|degraded|unhealthy|breached/.test(code)) {
        exclude('signal token is in a comment or string literal'); continue;
      }
      if (alarmCalls.length > 0) continue;
      if (/\b(?:console|logger|LOG|log)\./.test(code)) {
        // Generic logs are not fallbacks. Compare the independently parsed call's FULL span,
        // including multiline arguments, so moving the fallback literal cannot hide it.
        if (fallbackCalls > 0) continue;
        exclude('log does not announce a fallback decision'); continue;
      }
      if (/managedSetInterval/.test(code)) { exclude('interval name is not a watchdog, or its module already has a watchdog-module site'); continue; }
      if (/\bwaiver\s*:/.test(code)) { exclude('waiver outside a defineSignal registry'); continue; }
      exclude('health token outside health scope, type member, reference, or declaration');
    }
  }
  expect(Object.keys(exclusions).length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
}, 120_000);
