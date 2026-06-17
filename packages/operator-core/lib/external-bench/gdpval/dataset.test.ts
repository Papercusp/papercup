import { describe, expect, it } from 'vitest';
import {
  buildGdpvalDownloadCommand,
  gdpvalGroupCounts,
  gdpvalPilotSubset,
  gdpvalTaskToBenchTask,
  parseGdpvalJsonl,
  parseGdpvalRow,
} from './dataset';

const ROW = {
  task_id: '83d10b06-26d1-4636-a32c-23f92c57f30b',
  sector: 'Professional, Scientific, and Technical Services',
  occupation: 'Accountants and Auditors',
  prompt: 'You are an auditor… review and tie out the population.',
  rubric_pretty: "[+2] The submitted deliverable is an Excel workbook…",
  rubric_json: [{ score: 2, criterion: 'is an Excel workbook' }],
  reference_file_urls: ['https://huggingface.co/datasets/openai/gdpval/resolve/main/reference_files/x/Population.xlsx'],
  deliverable_file_urls: ['https://huggingface.co/datasets/openai/gdpval/resolve/main/deliverable_files/y/Sample.xlsx'],
};

describe('gdpval dataset — parseGdpvalRow', () => {
  it('maps the confirmed schema', () => {
    const t = parseGdpvalRow(ROW);
    expect(t.taskId).toBe(ROW.task_id);
    expect(t.occupation).toBe('Accountants and Auditors');
    expect(t.sector).toContain('Professional');
    expect(t.prompt).toContain('auditor');
    expect(t.rubric).toContain('Excel workbook');
    expect(t.referenceInputUrls).toHaveLength(1);
    expect(t.referenceDeliverableUrls[0]).toContain('deliverable_files');
  });

  it('tolerates JSON-array-string url fields', () => {
    const t = parseGdpvalRow({ ...ROW, reference_file_urls: '["https://a/x"]', deliverable_file_urls: '["https://b/y"]' });
    expect(t.referenceInputUrls).toEqual(['https://a/x']);
    expect(t.referenceDeliverableUrls).toEqual(['https://b/y']);
  });

  it('throws on missing task_id / prompt', () => {
    expect(() => parseGdpvalRow({ prompt: 'x' })).toThrow(/task_id/);
    expect(() => parseGdpvalRow({ task_id: 't' })).toThrow(/prompt/);
  });
});

describe('gdpval dataset — counts + pilot subset', () => {
  const body = [
    JSON.stringify({ ...ROW, task_id: 'a', occupation: 'Lawyers', sector: 'Legal' }),
    JSON.stringify({ ...ROW, task_id: 'c', occupation: 'Lawyers', sector: 'Legal' }),
    JSON.stringify({ ...ROW, task_id: 'b', occupation: 'Nurses', sector: 'Health' }),
  ].join('\n');

  it('parses + counts occupations/sectors', () => {
    const tasks = parseGdpvalJsonl(body);
    expect(tasks).toHaveLength(3);
    expect(gdpvalGroupCounts(tasks)).toEqual({ occupations: 2, sectors: 2, tasks: 3 });
  });

  it('gdpvalPilotSubset takes 1 task per occupation, deterministically by taskId', () => {
    const sub = gdpvalPilotSubset(parseGdpvalJsonl(body));
    // Lawyers → 'a' (first by id), Nurses → 'b'.
    expect(sub.map((t) => t.taskId).sort()).toEqual(['a', 'b']);
  });
});

describe('gdpval dataset — gdpvalTaskToBenchTask', () => {
  it('prompt in problemStatement; rubric + reference deliverable + occupation/sector in graderMeta (arm never sees the reference)', () => {
    const bt = gdpvalTaskToBenchTask(parseGdpvalRow(ROW));
    expect(bt.benchmark).toBe('gdpval');
    expect(bt.instanceId).toBe(ROW.task_id);
    expect(bt.problemStatement).toContain('auditor');
    expect(bt.problemStatement).not.toContain('Sample.xlsx'); // the reference deliverable stays out of the arm-visible brief
    expect(bt.graderMeta).toMatchObject({ occupation: 'Accountants and Auditors', sector: expect.stringContaining('Professional') });
    expect((bt.graderMeta.referenceDeliverableUrls as string[])[0]).toContain('deliverable_files');
    expect(bt.graderMeta.rubric).toContain('Excel workbook');
  });
});

describe('gdpval dataset — buildGdpvalDownloadCommand', () => {
  it('builds a public huggingface_hub snapshot command (no token)', () => {
    const { cmd, args } = buildGdpvalDownloadCommand({ pythonBin: '/venv/bin/python', destRoot: '/out' });
    expect(cmd).toBe('/venv/bin/python');
    expect(args[1]).toContain('openai/gdpval');
    expect(args[1]).toContain('snapshot_download');
    expect(args[1]).not.toContain('token'); // public — no token
  });
});
