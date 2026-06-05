import { snapshotClaudeCorpus, writeCorpusFixture } from '../../packages/operator-core/lib/memory/bench/corpus';

const memoryDir = '/home/marsh-office/.claude/projects/-home-marsh-office/memory';
const entries = await snapshotClaudeCorpus(memoryDir);
console.log('snapshotted', entries.length, 'entries');
const kinds = entries.reduce<Record<string, number>>((acc, e) => {
  acc[e.kind ?? '?'] = (acc[e.kind ?? '?'] ?? 0) + 1;
  return acc;
}, {});
console.log('kinds:', JSON.stringify(kinds));
const empty = entries.filter((e) => !e.text.trim());
console.log('empty-text entries:', empty.map((e) => e.key));
const file = writeCorpusFixture(entries, 'v1');
console.log('wrote', file);
process.exit(0);
