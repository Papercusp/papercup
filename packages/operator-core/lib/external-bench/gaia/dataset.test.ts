import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildGaiaDownloadCommand,
  gaiaLevelCounts,
  gaiaTaskToBenchTask,
  loadGaiaTasks,
  parseGaiaMetadataJsonl,
  parseGaiaRow,
  stratifiedGaiaSubset,
  type GaiaTask,
} from './dataset';

/** A representative validation row (the confirmed GAIA metadata.jsonl schema). */
const SAMPLE_ROW = {
  task_id: 'c61d22de-5f6c-4958-a7f6-5e9707bd3466',
  Question: 'What was the actual enrollment count of the clinical trial on H. pylori?',
  Level: '1',
  'Final answer': '90',
  file_name: '',
  file_path: '',
  'Annotator Metadata': { Steps: '1. Search...', 'Number of steps': '3', Tools: 'web browser' },
};

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

describe('gaia dataset — parseGaiaRow', () => {
  it('maps the confirmed schema, coercing level to a number', () => {
    const t = parseGaiaRow(SAMPLE_ROW);
    expect(t.taskId).toBe('c61d22de-5f6c-4958-a7f6-5e9707bd3466');
    expect(t.question).toContain('clinical trial');
    expect(t.level).toBe(1);
    expect(t.finalAnswer).toBe('90');
    expect(t.fileName).toBe('');
    expect(t.filePath).toBeUndefined();
    expect(t.annotatorMetadata).toMatchObject({ Tools: 'web browser' });
  });

  it('resolves a non-empty file_name to an absolute staged path under dir', () => {
    const t = parseGaiaRow({ ...SAMPLE_ROW, file_name: 'data.xlsx' }, '/staged/gaia/validation');
    expect(t.fileName).toBe('data.xlsx');
    expect(t.filePath).toBe('/staged/gaia/validation/data.xlsx');
  });

  it('prefers an absolute file_path when provided', () => {
    const t = parseGaiaRow({ ...SAMPLE_ROW, file_name: 'x.png', file_path: '/abs/x.png' }, '/staged');
    expect(t.filePath).toBe('/abs/x.png');
  });

  it('tolerates lowercase/variant key spellings', () => {
    const t = parseGaiaRow({ task_id: 't', question: 'Q?', level: 2, final_answer: 'A' });
    expect(t).toMatchObject({ taskId: 't', question: 'Q?', level: 2, finalAnswer: 'A' });
  });

  it('throws on a missing question or unparseable level', () => {
    expect(() => parseGaiaRow({ task_id: 't', Level: '1' })).toThrow(/missing Question/);
    expect(() => parseGaiaRow({ task_id: 't', Question: 'Q', Level: 'hard' })).toThrow();
    expect(() => parseGaiaRow({ Question: 'Q', Level: '1' })).toThrow(/missing task_id/);
  });
});

describe('gaia dataset — parseGaiaMetadataJsonl + counts + subset', () => {
  const body = [
    JSON.stringify({ task_id: 'a', Question: 'q', Level: '1', 'Final answer': '1' }),
    JSON.stringify({ task_id: 'b', Question: 'q', Level: '1', 'Final answer': '2' }),
    JSON.stringify({ task_id: 'c', Question: 'q', Level: '2', 'Final answer': '3' }),
    '', // blank line tolerated
    JSON.stringify({ task_id: 'd', Question: 'q', Level: '3', 'Final answer': '4' }),
  ].join('\n');

  it('parses all non-blank lines', () => {
    const tasks = parseGaiaMetadataJsonl(body);
    expect(tasks.map((t) => t.taskId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('counts per level', () => {
    expect(gaiaLevelCounts(parseGaiaMetadataJsonl(body))).toEqual({ 1: 2, 2: 1, 3: 1 });
  });

  it('stratifiedGaiaSubset takes up to N per level, deterministically by taskId', () => {
    const tasks = parseGaiaMetadataJsonl(body);
    const sub = stratifiedGaiaSubset(tasks, 1);
    // 1 per level: L1 -> 'a' (first by id), L2 -> 'c', L3 -> 'd'.
    expect(sub.map((t) => t.taskId)).toEqual(['a', 'c', 'd']);
    // Determinism.
    expect(stratifiedGaiaSubset(tasks, 1).map((t) => t.taskId)).toEqual(sub.map((t) => t.taskId));
  });
});

describe('gaia dataset — gaiaTaskToBenchTask', () => {
  it('puts the question in problemStatement and gold/level/file in graderMeta (arm never sees gold)', () => {
    const task: GaiaTask = {
      taskId: 't1',
      question: 'What is X?',
      level: 2,
      finalAnswer: 'secret-gold',
      fileName: 'a.csv',
      filePath: '/staged/a.csv',
    };
    const bt = gaiaTaskToBenchTask(task);
    expect(bt.benchmark).toBe('gaia');
    expect(bt.instanceId).toBe('t1');
    expect(bt.problemStatement).toBe('What is X?');
    expect(bt.problemStatement).not.toContain('secret-gold'); // gold stays out of the arm-visible brief
    expect(bt.graderMeta).toMatchObject({ finalAnswer: 'secret-gold', level: 2, fileName: 'a.csv', filePath: '/staged/a.csv' });
  });
});

describe('gaia dataset — loadGaiaTasks', () => {
  it('throws an actionable gated-provisioning error when the corpus is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gaia-empty-'));
    cleanup.push(empty);
    expect(() => loadGaiaTasks(empty)).toThrow(/gated|provision|HF token/i);
  });

  it('loads tasks from a provisioned metadata.jsonl and stages attachment paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gaia-corpus-'));
    cleanup.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'metadata.jsonl'),
      [
        JSON.stringify({ task_id: 'x', Question: 'q1', Level: '1', 'Final answer': '10', file_name: '' }),
        JSON.stringify({ task_id: 'y', Question: 'q2', Level: '2', 'Final answer': '20', file_name: 'sheet.xlsx' }),
      ].join('\n'),
    );
    const tasks = loadGaiaTasks(dir);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].filePath).toBe(join(dir, 'sheet.xlsx'));
  });
});

describe('gaia dataset — buildGaiaDownloadCommand', () => {
  it('builds a huggingface_hub snapshot command scoped to the requested split', () => {
    const { cmd, args } = buildGaiaDownloadCommand({ pythonBin: '/venv/bin/python', destRoot: '/out', split: 'validation' });
    expect(cmd).toBe('/venv/bin/python');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('snapshot_download');
    expect(args[1]).toContain('gaia-benchmark/GAIA');
    expect(args[1]).toContain('2023/validation/*');
    expect(args[1]).toContain('HF_TOKEN');
  });
});
