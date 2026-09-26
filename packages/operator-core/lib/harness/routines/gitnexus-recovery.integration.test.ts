import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { analyzeCliPath, gitnexusMetaPath } from './gitnexus-reindex-action';

/** A real reader dies and a new reader must answer from the same indexed snapshot. */
describe('GitNexus disposable graph-reader recovery', () => {
  it('recovers a known call edge after a reader is killed without changing snapshot provenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-reader-restart-'));
    const repo = `reader-restart-${process.pid}`;
    const cli = analyzeCliPath();
    const env = Object.fromEntries(Object.entries({
      ...process.env,
      GITNEXUS_REGISTRY_PATH: join(root, 'registry.json'),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const readers: Array<{ client: Client; transport: StdioClientTransport }> = [];
    const startReader = async () => {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [cli, 'mcp'], cwd: root, env, stderr: 'pipe',
      });
      const client = new Client({ name: 'gitnexus-recovery-test', version: '1.0.0' });
      await client.connect(transport);
      const reader = { client, transport };
      readers.push(reader);
      return reader;
    };
    const knownEdgeCount = async (client: Client): Promise<number> => {
      const result = await client.callTool({
        name: 'cypher',
        arguments: {
          repo,
          statement: "MATCH (caller:Function)-[r:CodeRelation]->(callee:Function) WHERE caller.name = 'caller' AND callee.name = 'dependency' AND r.type = 'CALLS' RETURN count(r) AS n",
        },
      });
      const body = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
      if (result.isError) throw new Error(`GitNexus reader error: ${body}`);
      const cell = /\|\s*(\d+)\s*\|/.exec(body);
      if (!cell) throw new Error(`GitNexus returned no edge count: ${body.slice(-500)}`);
      return Number(cell[1]);
    };

    try {
      execFileSync('git', ['init', '-q', root], { timeout: 10_000 });
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'graph.ts'),
        'export function dependency() { return 1; }\n' +
        'export function caller() { return dependency(); }\n');
      execFileSync(process.execPath,
        [cli, 'analyze', root, '--skip-agents-md', '--name', repo, '--force'],
        { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const metaBefore = readFileSync(gitnexusMetaPath(root), 'utf8');
      expect(JSON.parse(metaBefore).indexedAt).toEqual(expect.any(String));

      const first = await startReader();
      expect(await knownEdgeCount(first.client)).toBeGreaterThan(0);
      const firstPid = first.transport.pid;
      expect(firstPid).not.toBeNull();
      process.kill(firstPid!, 'SIGKILL');
      await first.client.close();

      const second = await startReader();
      expect(second.transport.pid).not.toBe(firstPid);
      expect(await knownEdgeCount(second.client)).toBeGreaterThan(0);
      expect(readFileSync(gitnexusMetaPath(root), 'utf8')).toBe(metaBefore);
    } finally {
      await Promise.all(readers.map((reader) => reader.client.close().catch(() => undefined)));
      rmSync(root, { recursive: true, force: true });
    }
  }, 300_000);
});
