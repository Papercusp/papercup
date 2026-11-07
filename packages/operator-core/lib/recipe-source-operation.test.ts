import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { compileSourceOperation, describeRecipeSourceOperation, resolveRecipeSourceOperation,
  type RecipeOperationSource } from './recipe-source-operation';
import type { SqlIntentScope } from './bash-substitution/sql-intent-fingerprint';

const now = Date.parse('2026-11-07T05:00:00Z');
const scope: SqlIntentScope = { workspaceId: 'w', sourceBoundary: 'authorized-tool-ledger', epoch: '2026-11',
  key: Buffer.alloc(32, 9) };
const source = (tool: string, args: unknown): RecipeOperationSource => ({
  id: '123', workspaceId: 'w', harness: 'h', at: new Date(now - 1000).toISOString(), tool, args,
});
const sql = () => source('dev:pg_query', { sql: 'SELECT $1::text AS value, $2::int AS n', parameters: ['private-sample', 7] });
const bash = () => source('capability:bash', { command: "printf '%s\\n' 'private-sample'", cwd: '/tmp' });
const resolve = (s: RecipeOperationSource, overrides: Partial<Parameters<typeof resolveRecipeSourceOperation>[0]> = {}) => {
  const definition = describeRecipeSourceOperation(s, scope, now)!;
  return resolveRecipeSourceOperation({ ...definition, workspaceId: 'w', harness: 'h', scope,
    read: async () => s, now, ...overrides });
};

describe('private SQL/shell recipe source contract', () => {
  it.each([sql, bash])('stores a locator and typed schema without source or sample values', make => {
    const definition = describeRecipeSourceOperation(make(), scope, now)!;
    expect(definition).not.toBeNull();
    const serialized = JSON.stringify(definition);
    expect(serialized).not.toContain('private-sample');
    expect(serialized).not.toContain('SELECT');
    expect(serialized).not.toContain('printf');
    expect(definition.bindingSchema.properties.value0).toMatchObject({ type: 'string', required: true });
  });

  it('keeps hostile SQL values separate from immutable query bytes', async () => {
    const op = await resolve(sql());
    const hostile = "x'); SELECT pg_sleep(30); --";
    expect(op!.prepare({ value0: hostile, value1: 11 })).toEqual({ sql: sql().args && (sql().args as { sql: string }).sql,
      parameters: [hostile, 11] });
    expect(op!.prepare({ value0: {}, value1: 11 })).toBeNull();
    expect(op!.prepare({ value0: 'x', value1: Infinity })).toBeNull();
    expect(op!.prepare({ value0: 'x', value1: '11' })).toBeNull();
    expect(op!.prepare({ value0: 'x', value1: 11, __sourceOperation: {} })).toBeNull();
  });

  it('quotes shell values as data in a real interpreter', async () => {
    const op = await resolve(bash());
    const hostile = "'; printf INJECTED; # $(printf SUBSTITUTED) `printf BACKTICK`";
    const args = op!.prepare({ value0: hostile })!;
    expect(execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', String(args.command)], { encoding: 'utf8' })).toBe(hostile + '\n');
    expect(op!.prepare({ value0: 'x\0y' })).toBeNull();
    expect(op!.prepare({ value0: ['a'] })).toBeNull();
  });

  it.each([sql, bash])('renews permission after a successful warm read', async make => {
    const s = make(), read = vi.fn().mockResolvedValueOnce(s).mockResolvedValue(null);
    expect(await resolve(s, { read })).not.toBeNull();
    expect(await resolve(s, { read })).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([sql, bash])('rejects stale, cross-scope, tampered and unsupported references before dispatch', async make => {
    const s = make(), definition = describeRecipeSourceOperation(s, scope, now)!;
    for (const overrides of [
      { workspaceId: 'other' }, { harness: 'other' }, { now: now + 31 * 86400_000 },
      { scope: { ...scope, epoch: '2026-12' } }, { scope: { ...scope, key: Buffer.alloc(32, 8) } },
      { script: definition.script + '\nreturn "extra";' }, { bindingSchema: null },
      { read: async () => ({ ...s, args: { ...(s.args as object), changed: true } }) },
      { read: async () => null }, { read: async () => { throw new Error('unavailable'); } },
    ]) expect(await resolve(s, overrides)).toBeNull();
  });

  it.each([
    ['dev:pg_query', { sql: 'DELETE FROM private_table' }],
    ['dev:pg_query', { sql: 'SELECT $1', parameters: [{}] }],
    ['dev:pg_query', { sql: 'SELECT 1; SELECT 2' }],
    ['capability:bash', { command: 'echo a > /tmp/private-output', cwd: '/tmp' }],
    ['capability:bash', { command: 'echo $(touch /tmp/private-output)', cwd: '/tmp' }],
    ['capability:bash', { command: 'echo a; echo b', cwd: '/tmp' }],
    ['capability:bash', { command: 'env echo a', cwd: '/tmp' }],
    ['capability:bash', { command: 'rm -rf /tmp/private-output', cwd: '/tmp' }],
    ['capability:bash', { command: 'echo $PRIVATE', cwd: '/tmp' }],
    ['capability:bash', { command: 'echo a', cwd: '/tmp', run_in_background: true }],
    ['capability:bash', { command: 'echo a', cwd: '/tmp', integration_env: { MODE: 'PRIVATE_KEY_REF' } }],
    ['capability:bash', { command: 'echo a', cwd: '/tmp', environment: { MODE: 'different' } }],
    ['capability:bash', { command: 'echo a', cwd: '/tmp', env: { MODE: 'different' } }],
  ])('keeps unsupported %s syntax opaque', (tool, args) => {
    expect(compileSourceOperation({ tool: tool as string, args }, scope)).toBeNull();
  });

  it('rejects known private credentials instead of capturing a keyed sample', () => {
    expect(compileSourceOperation(sql(), { ...scope, knownSecrets: ['private-sample'] })).toBeNull();
    expect(compileSourceOperation(bash(), { ...scope, knownSecrets: ['private-sample'] })).toBeNull();
    expect(compileSourceOperation({ tool: 'dev:pg_query', args: { sql: 'SELECT 1', api_key: 'opaque' } }, scope)).toBeNull();
    expect(compileSourceOperation({ tool: 'dev:pg_query', args: { sql: 'SELECT 1', _truncated: true } }, scope)).toBeNull();
    const inherited = Object.assign(Object.create({ value0: 'inherited' }), { other: 'own' });
    expect(compileSourceOperation(bash(), scope)!.prepare(inherited)).toBeNull();
  });
});
