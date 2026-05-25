import { describe, it, expect } from 'vitest';
import {
  parseEngramsYaml,
  classifyKind,
  migrateEngram,
  emitJsonl,
  emitRememberCmds,
  type PlurEngram,
} from './migrate-plur-to-mem0';

const SAMPLE = `engrams:
  - id: ENG-2026-001
    version: 2
    status: active
    type: behavioral
    statement: >-
      User prefers terse responses.
      Avoid restating context.
    rationale: >-
      Confirmed in session ABC.
    domain: software.responses
    tags:
      - terse
      - preference
    knowledge_type:
      memory_class: semantic
      cognitive_level: apply
  - id: ENG-2026-002
    status: retired
    type: project
    statement: Old fact that no longer applies
    tags: []
  - id: ENG-2026-003
    status: active
    type: correction
    statement: When unsure use foo()
    tags:
      - api
`;

describe('parseEngramsYaml', () => {
  it('parses multiple engrams', () => {
    const e = parseEngramsYaml(SAMPLE);
    expect(e.length).toBe(3);
    expect(e[0].id).toBe('ENG-2026-001');
    expect(e[1].id).toBe('ENG-2026-002');
    expect(e[2].id).toBe('ENG-2026-003');
  });

  it('folds multi-line >- scalar', () => {
    const e = parseEngramsYaml(SAMPLE);
    expect(e[0].statement).toBe('User prefers terse responses. Avoid restating context.');
  });

  it('captures tags', () => {
    const e = parseEngramsYaml(SAMPLE);
    expect(e[0].tags).toEqual(['terse', 'preference']);
    expect(e[2].tags).toEqual(['api']);
  });

  it('captures knowledge_type', () => {
    const e = parseEngramsYaml(SAMPLE);
    expect(e[0].knowledge_type).toEqual({ memory_class: 'semantic', cognitive_level: 'apply' });
  });

  it('returns [] for empty/invalid', () => {
    expect(parseEngramsYaml('')).toEqual([]);
    expect(parseEngramsYaml('not yaml')).toEqual([]);
  });
});

describe('classifyKind', () => {
  it('correction type', () => {
    const e = { id: 'x', statement: 's', type: 'correction' } as PlurEngram;
    expect(classifyKind(e)).toBe('correction');
  });
  it('project type', () => {
    const e = { id: 'x', statement: 's', type: 'project' } as PlurEngram;
    expect(classifyKind(e)).toBe('project');
  });
  it('software.* domain → project', () => {
    const e = { id: 'x', statement: 's', domain: 'software.foo' } as PlurEngram;
    expect(classifyKind(e)).toBe('project');
  });
  it('default → preference', () => {
    const e = { id: 'x', statement: 's' } as PlurEngram;
    expect(classifyKind(e)).toBe('preference');
  });
});

describe('migrateEngram', () => {
  it('combines statement + rationale', () => {
    const e = {
      id: 'x', statement: 'Do X', rationale: 'Because Y',
    } as PlurEngram;
    const m = migrateEngram(e);
    expect(m.content).toBe('Do X\n\nRationale: Because Y');
    expect(m.source_id).toBe('x');
  });

  it('uses statement alone when no rationale', () => {
    const e = { id: 'x', statement: 'Do X', tags: ['t'] } as PlurEngram;
    const m = migrateEngram(e);
    expect(m.content).toBe('Do X');
    expect(m.tags).toEqual(['t']);
  });
});

describe('emitJsonl', () => {
  it('emits one JSON object per line', () => {
    const out = emitJsonl([
      { source_id: 'a', kind: 'preference', content: 'x', tags: [], status: 'active' },
      { source_id: 'b', kind: 'project', content: 'y', tags: [], status: 'active' },
    ]);
    const lines = out.split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({
      source_id: 'a', kind: 'preference', content: 'x', tags: [], status: 'active',
    });
  });
});

describe('emitRememberCmds', () => {
  it('emits a curl command per entry', () => {
    const out = emitRememberCmds(
      [{ source_id: 'a', kind: 'preference', content: 'hello', tags: ['t'], status: 'active' }],
      'http://test/api/mcp?superuser=1',
    );
    expect(out).toContain('# source: a (preference) [t]');
    expect(out).toContain('curl');
    expect(out).toContain('memory:remember');
  });
});

describe('integration — sample full pipeline', () => {
  it('parses + classifies + emits', () => {
    const engrams = parseEngramsYaml(SAMPLE);
    const active = engrams.filter((e) => (e.status ?? 'active') === 'active');
    const entries = active.map(migrateEngram);

    expect(entries.length).toBe(2); // ENG-002 (retired) filtered out
    const byId = Object.fromEntries(entries.map((e) => [e.source_id, e]));
    expect(byId['ENG-2026-001'].kind).toBe('project'); // domain=software.*
    expect(byId['ENG-2026-003'].kind).toBe('correction');
  });
});
