/** Real Codex request boundary, entirely local: no credentials or paid inference. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveOnPath, wellKnownBackendBin } from './backend-bin-resolve.mjs';
import { mcpBootstrapInstructions, mcpToolsWithBootstrap } from './endpoint-route/routes/transport/mcp-contract';
import { capabilityMapText } from './agent-tools/tools/capability-map';
import { captureNativeMcp, type Descriptor } from './memory/fixtures/native-mcp-export';

const codex = wellKnownBackendBin('codex') ?? resolveOnPath('codex');
const marker = 'PAPERCUSP_OFFLINE_INITIALIZE_CANARY';
const sharedInstructions = `${marker}\n${'Preserve the current owner instructions and discover the needed tools.\n'.repeat(290)}`.trimEnd();
const captureMcpWire = (tools: Descriptor[], instructions?: string) => captureNativeMcp('codex', tools, instructions);

describe('native Codex MCP instruction wire', () => {
  it.runIf(Boolean(codex)).each([2, 55])('carries shared guidance once with %i tools at the real request boundary', async toolCount => {
      const toolNames = ['read_canary', 'find_canary', ...Array.from({ length: toolCount - 2 }, (_, i) => `extra_canary_${i}`)];
      const { request, clientVersion } = await captureMcpWire(toolNames.map(name => ({ name,
        description: `Public fixture ${name}.` })), sharedInstructions);
      const wire = JSON.stringify(request);
      const count = wire.split(marker).length - 1;
      const descriptionHits: string[] = [];
      const markerLocations: string[] = [];
      const guidanceValues: string[] = [];
      const walk = (value: unknown, path = '$'): void => {
        if (typeof value === 'string' && value.includes(marker)) { markerLocations.push(path); guidanceValues.push(value); }
        if (Array.isArray(value)) { value.forEach((part, index) => walk(part, `${path}[${index}]`)); return; }
        if (!value || typeof value !== 'object') return;
        const row = value as Record<string, unknown>;
        if (typeof row.description === 'string' && row.description.includes(marker)) descriptionHits.push(String(row.name));
        Object.entries(row).forEach(([key, part]) => walk(part, `${path}.${key}`));
      };
      walk(request);
      console.info('CODEX_MCP_WIRE_EVIDENCE ' + JSON.stringify({ tools: toolNames.length,
        initializeInstructionCopies: count, descriptionsWithInstructions: descriptionHits.length,
        markerLocations, requestBytes: Buffer.byteLength(wire),
        clientVersion }));
      // The current native request must carry shared server guidance once, independently
      // of the number of tools. This guards the charged boundary, not catalog characters.
      expect(count, JSON.stringify({ descriptionHits, markerLocations })).toBe(1);
      expect(descriptionHits.length, JSON.stringify(markerLocations)).toBeLessThanOrEqual(1);
      expect(guidanceValues).toHaveLength(1);
      expect(guidanceValues[0], JSON.stringify({ actualChars: guidanceValues[0]?.length,
        expectedChars: sharedInstructions.length, markerLocations })).toContain(sharedInstructions);
      for (const name of toolNames) expect(wire).toContain(name);
  }, 30_000);

  it('replays the frozen 55-tool contract through the installed Codex export', async ({ task }) => {
    const bytes = readFileSync(new URL('./memory/fixtures/r7-native-pre-change.json', import.meta.url));
    const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
    expect(hash(bytes)).toBe('986f440eeaf59cf02a400fcd1caf206edae88cc7b04ccd95a91ba29235560ed4');
    const baseline = JSON.parse(bytes.toString('utf8')) as { tools: Descriptor[] };
    let prefix = baseline.tools[0]!.description;
    for (const tool of baseline.tools.slice(1)) {
      let index = 0;
      while (index < prefix.length && prefix[index] === tool.description[index]) index++;
      prefix = prefix.slice(0, index);
    }
    expect(prefix.length).toBe(19367);
    const contracts = baseline.tools.map(tool => ({ ...tool, description: tool.description.slice(prefix.length) }));
    const guidance = mcpBootstrapInstructions(capabilityMapText());
    const exported = mcpToolsWithBootstrap(contracts, guidance);
    const before = await captureMcpWire(baseline.tools);
    const after = await captureMcpWire(exported);
    expect(after.clientVersion).toBe(before.clientVersion);
    const descriptors = (request: Record<string, unknown>) => {
      const rows: Descriptor[] = [];
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== 'object') return;
        const row = value as Record<string, unknown>;
        if (typeof row.name === 'string' && typeof row.description === 'string' &&
            row.description.includes('exec tool declaration:')) rows.push({ name: row.name, description: row.description });
        Object.values(row).forEach(visit);
      };
      visit(request.tools);
      return rows;
    };
    const oldRows = descriptors(before.request), newRows = descriptors(after.request);
    expect(oldRows).toHaveLength(55);
    expect(newRows).toHaveLength(55);
    expect(newRows.map(row => row.name)).toEqual(oldRows.map(row => row.name));
    for (const contract of contracts) {
      expect(newRows.filter(row => row.description.endsWith(contract.description))).toHaveLength(1);
    }
    const beforeText = JSON.stringify(oldRows), afterText = JSON.stringify(newRows);
    expect(afterText.split('<!-- papercusp-mcp-bootstrap:v1 -->').length - 1).toBe(1);
    expect(afterText.split(prefix).length - 1).toBe(0);
    expect(Buffer.byteLength(afterText)).toBeLessThan(Buffer.byteLength(beforeText));
    Object.assign(task.meta, { nativeBootstrapReplay: {
      client: 'codex', clientVersion: after.clientVersion, evidencePlane: 'installed-client-local-request',
      baselineHash: hash(bytes), toolCount: newRows.length,
      beforeBytes: Buffer.byteLength(beforeText), afterBytes: Buffer.byteLength(afterText),
      beforeHash: hash(beforeText), afterHash: hash(afterText), commonBootstrapCopies: 1,
      typedContractsPreserved: true, inputSchema: 'owned-empty-object-fixture',
      productionRuntime: 'UNKNOWN', billedTokens: 'UNKNOWN',
    } });
  }, 90_000);
});
