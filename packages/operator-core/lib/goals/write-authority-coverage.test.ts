import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOOL_DIRS = [
  join(ROOT, 'packages/agent-mcp/src/tools/goals'),
  join(ROOT, 'packages/operator-core/lib/agent-tools/goals'),
];
const WRITE_CAPABILITY = /capability:\s*['"]goals:write['"]/;
const TOOL_NAME = /name:\s*['"](goals:[^'"]+)['"]/g;
const FENCE = /\bassertGoalWriteAuthorityForCaller\s*\(/;

// This door produces a proposal card and explicitly writes nothing. It keeps
// the write capability because the confirmed card chains to goals:create.
const ZERO_WRITE_EXEMPTIONS = new Map([
  ['goals:propose', 'proposal-only: handler returns a confirm card and performs no write'],
]);

function sourceFiles(): string[] {
  return TOOL_DIRS.flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'))
      .map((entry) => join(dir, entry.name)),
  );
}

function writeToolSections(): Array<{ name: string; file: string; source: string }> {
  const out: Array<{ name: string; file: string; source: string }> = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const matches = [...source.matchAll(TOOL_NAME)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const start = match.index!;
      const end = matches[index + 1]?.index ?? source.length;
      const section = source.slice(start, end);
      if (!WRITE_CAPABILITY.test(section)) continue;
      out.push({ name: match[1]!, file, source: section });
    }
  }
  return out;
}

describe('write-side goals:* authority-fence registry lint', () => {
  it('routes every mutating goals:* handler through the elected-holder fence', () => {
    const writes = writeToolSections();
    const uncovered = writes
      .filter(({ name, source }) => !ZERO_WRITE_EXEMPTIONS.has(name) && !FENCE.test(source))
      .map(({ name, file }) => `${name} (${file.slice(ROOT.length + 1)})`);

    expect(uncovered).toEqual([]);
    expect(writes.map(({ name }) => name).sort()).toEqual([
      'goals:apply-package-update',
      'goals:arm-schedule',
      'goals:attach-pot',
      'goals:create',
      'goals:detach-pot',
      'goals:propose',
      'goals:set-input-schema',
      'goals:set-output-schema',
      'goals:set-property',
      'goals:set-schedule',
      'goals:start',
      'goals:start-from-package',
      'goals:update',
    ]);
  });
});
