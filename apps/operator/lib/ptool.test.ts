import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  serviceOf,
  groupTools,
  firstLine,
  normalizeType,
  promptSpecsFromSchema,
  coerceArg,
  mergeConvenienceArgs,
  prettyText,
  resultToText,
} from '../scripts/ptool.mjs';

describe('ptool parseArgs', () => {
  it('defaults to the interactive picker', () => {
    expect(parseArgs([])).toEqual({
      tool: null,
      json: null,
      list: false,
      listFilter: null,
      workspace: null,
      harness: null,
      raw: false,
      url: null,
      help: false,
    });
  });

  it('takes the first positional as the tool name', () => {
    expect(parseArgs(['harness:list']).tool).toBe('harness:list');
  });

  it('parses --json / --args as the args payload (= form)', () => {
    expect(parseArgs(['x:y', '--json={"a":1}']).json).toBe('{"a":1}');
    expect(parseArgs(['x:y', '--args={"a":1}']).json).toBe('{"a":1}');
  });

  it('parses value flags in the space-separated form', () => {
    expect(parseArgs(['x:y', '--json', '{"a":1}']).json).toBe('{"a":1}');
    const a = parseArgs(['x:y', '--workspace', 'ws1', '--harness', 'h', '--url', 'http://h:9']);
    expect(a).toMatchObject({ tool: 'x:y', workspace: 'ws1', harness: 'h', url: 'http://h:9' });
  });

  it('does not mistake a value-flag argument for the tool name', () => {
    // `{}` here is --json's value, not a positional tool name.
    expect(parseArgs(['--json', '{}', 'x:y']).tool).toBe('x:y');
    expect(parseArgs(['x:y', '--workspace', 'ws']).tool).toBe('x:y');
  });

  it('parses convenience + control flags', () => {
    const a = parseArgs(['x:y', '--workspace=ws1', '--harness=papercup', '--raw', '--url=http://h:9']);
    expect(a).toMatchObject({
      tool: 'x:y',
      workspace: 'ws1',
      harness: 'papercup',
      raw: true,
      url: 'http://h:9',
    });
  });

  it('treats a positional after --list as the catalog filter, not the tool', () => {
    const a = parseArgs(['--list', 'coord']);
    expect(a.list).toBe(true);
    expect(a.listFilter).toBe('coord');
    expect(a.tool).toBeNull();
  });

  it('recognizes help flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });
});

describe('ptool serviceOf / groupTools', () => {
  it('splits the service off the colon', () => {
    expect(serviceOf('work_items:list')).toBe('work_items');
    expect(serviceOf('papercusp:list_workspaces')).toBe('papercusp');
  });

  it('groups colon-less names under (misc)', () => {
    expect(serviceOf('weird')).toBe('(misc)');
  });

  it('groups + sorts services and tools', () => {
    const tools = [
      { name: 'harness:status', description: '' },
      { name: 'coord:send', description: '' },
      { name: 'harness:list', description: '' },
    ];
    const g = groupTools(tools);
    expect([...g.keys()]).toEqual(['coord', 'harness']);
    expect(g.get('harness').map((t) => t.name)).toEqual(['harness:list', 'harness:status']);
  });
});

describe('ptool firstLine', () => {
  it('returns the first non-empty line, truncated', () => {
    expect(firstLine('\n\nWhen to use: foo\nmore')).toBe('When to use: foo');
    expect(firstLine('a'.repeat(200), 10)).toBe('aaaaaaaaa…');
    expect(firstLine('')).toBe('');
    expect(firstLine(undefined)).toBe('');
  });
});

describe('ptool normalizeType', () => {
  it('passes through a plain type', () => {
    expect(normalizeType('string')).toBe('string');
  });
  it('drops null from a type union array', () => {
    expect(normalizeType(['string', 'null'])).toBe('string');
    expect(normalizeType(['null'])).toBeNull();
  });
  it('returns null for an absent type', () => {
    expect(normalizeType(undefined)).toBeNull();
  });
});

describe('ptool promptSpecsFromSchema', () => {
  it('classifies scalar kinds and marks required', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'the name' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        on: { type: 'boolean', default: true },
        mode: { enum: ['a', 'b'] },
      },
    };
    const specs = promptSpecsFromSchema(schema);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    expect(byName.name).toMatchObject({ kind: 'string', required: true, description: 'the name' });
    expect(byName.count.kind).toBe('integer');
    expect(byName.ratio.kind).toBe('number');
    expect(byName.on).toMatchObject({ kind: 'boolean', default: true });
    expect(byName.mode).toMatchObject({ kind: 'enum', enumValues: ['a', 'b'] });
  });

  it('falls back to json for arrays, objects, and unions', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object' },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    const kinds = Object.fromEntries(promptSpecsFromSchema(schema).map((s) => [s.name, s.kind]));
    expect(kinds).toEqual({ tags: 'json', meta: 'json', either: 'json' });
  });

  it('orders required props before optional ones', () => {
    const schema = {
      type: 'object',
      required: ['b'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
    };
    expect(promptSpecsFromSchema(schema).map((s) => s.name)).toEqual(['b', 'a', 'c']);
  });

  it('handles an empty / missing schema', () => {
    expect(promptSpecsFromSchema(undefined)).toEqual([]);
    expect(promptSpecsFromSchema({ type: 'object' })).toEqual([]);
  });
});

describe('ptool coerceArg', () => {
  it('coerces numbers and integers', () => {
    expect(coerceArg('number', '3.5')).toBe(3.5);
    expect(coerceArg('integer', '7')).toBe(7);
  });
  it('throws on malformed numbers', () => {
    expect(() => coerceArg('number', 'x')).toThrow(/not a number/);
    expect(() => coerceArg('integer', '3.5')).toThrow(/not an integer/);
  });
  it('parses json', () => {
    expect(coerceArg('json', '{"a":[1,2]}')).toEqual({ a: [1, 2] });
    expect(() => coerceArg('json', '{bad')).toThrow(/not valid JSON/);
  });
  it('passes strings, booleans, enums through', () => {
    expect(coerceArg('string', 'hi')).toBe('hi');
    expect(coerceArg('boolean', true)).toBe(true);
    expect(coerceArg('enum', 'a')).toBe('a');
  });
});

describe('ptool mergeConvenienceArgs', () => {
  const schema = { properties: { workspace: { type: 'string' }, harness: { type: 'string' }, x: { type: 'string' } } };

  it('injects workspace/harness only when the schema declares them', () => {
    expect(mergeConvenienceArgs({}, { workspace: 'ws', harness: 'h' }, schema)).toEqual({
      workspace: 'ws',
      harness: 'h',
    });
  });

  it('does not inject a flag the schema lacks', () => {
    const noHarness = { properties: { workspace: { type: 'string' } } };
    expect(mergeConvenienceArgs({}, { workspace: 'ws', harness: 'h' }, noHarness)).toEqual({ workspace: 'ws' });
  });

  it('existing args win over the convenience flags', () => {
    expect(mergeConvenienceArgs({ workspace: 'explicit' }, { workspace: 'flag' }, schema)).toEqual({
      workspace: 'explicit',
    });
  });

  it('ignores null flags', () => {
    expect(mergeConvenienceArgs({ x: 1 }, { workspace: null, harness: null }, schema)).toEqual({ x: 1 });
  });
});

describe('ptool prettyText / resultToText', () => {
  it('pretty-prints JSON payloads, leaves plain text alone', () => {
    expect(prettyText('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyText('hello')).toBe('hello');
    expect(prettyText('{not json')).toBe('{not json');
    expect(prettyText('')).toBe('');
  });

  it('flattens an MCP content[] into text', () => {
    const result = { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] };
    expect(resultToText(result)).toBe('a\nb');
  });

  it('renders non-text content parts as JSON', () => {
    const result = { content: [{ type: 'image', data: 'x' }] };
    expect(resultToText(result)).toBe('{"type":"image","data":"x"}');
  });
});
