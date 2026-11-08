/** Database-independent R-7 integration observations through installed native clients.
 * Private homes and local refusal keep provider calls and credentials out of
 * this fixture. Native registration/request evidence does not prove shipment. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { mcpBootstrapInstructions, mcpToolsWithBootstrap } from '../endpoint-route/routes/transport/mcp-contract';
import { lintInstructionText } from '../instruction-lint';
import { capabilityMapText } from '../agent-tools/tools/capability-map';
import { DELIVERY_MATRIX_CLIENTS, bootstrapDescriptionForClient, validateBootstrapExportArtifact,
  type BootstrapExportArtifact, type BootstrapExportCell } from './injection-delivery-coverage';
import { captureNativeMcp, frozenBootstrap, baselineHash, requestDescriptors, sha256 } from './fixtures/native-mcp-export';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('context reliability R-7: immutable-native-baseline', ({ task }) => {
  const bytes = readFileSync(new URL('./fixtures/r7-native-pre-change.json', import.meta.url));
  expect(bytes.byteLength).toBe(1228154);
  const artifactHash = createHash('sha256').update(bytes).digest('hex');
  expect(artifactHash).toBe('986f440eeaf59cf02a400fcd1caf206edae88cc7b04ccd95a91ba29235560ed4');
  const baseline = JSON.parse(bytes.toString('utf8')) as {
    toolCount: number; toolOrder: string[]; wireSha256: string; wireBytes: number;
    schemaSetSha256: string; descriptionBytes: number;
    tools: Array<{ name: string; description: string }>;
  };
  expect(baseline.tools).toHaveLength(55);
  expect(baseline.toolCount).toBe(55);
  expect(new Set(baseline.toolOrder).size).toBe(55);
  expect(baseline.tools.map(tool => tool.name)).toEqual(baseline.toolOrder);
  const wire = JSON.stringify(baseline.tools);
  const wireHash = createHash('sha256').update(wire).digest('hex');
  expect(Buffer.byteLength(wire, 'utf8')).toBe(1225418);
  expect(baseline.wireBytes).toBe(1225418);
  expect(wireHash).toBe('ff92740e7592370b394c85044dd925d17d9a2200379c0cd89827319fbef67e85');
  expect(baseline.wireSha256).toBe(wireHash);
  expect(baseline.tools.reduce((sum, tool) => sum + Buffer.byteLength(tool.description, 'utf8'), 0)).toBe(1205060);
  expect(baseline.descriptionBytes).toBe(1205060);
  expect(baseline.schemaSetSha256).toBe('f21fd4cbc08b6b17642588472c6b4db2ff1fc2e0023e7151f02a01863edb9d56');
  for (const tool of baseline.tools) expect(tool.description).toContain('exec tool declaration:');
  Object.assign(task.meta, { bootstrapBaseline: { artifactHash, wireHash,
    fixture: 'r7-native-pre-change.json', evidencePlane: 'immutable-native-metadata-baseline',
    tools: baseline.tools.length, artifactBytes: bytes.byteLength, wireBytes: Buffer.byteLength(wire, 'utf8') } });
});

/** Replay the immutable native descriptor population through the same batch
 * decorator the HTTP/native host uses. This is a server-export replay, not a
 * claim about installed clients, external reinsertion or billed tokens. */
function bootstrapReplay() {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/r7-native-pre-change.json', import.meta.url), 'utf8')) as {
    tools: Array<{ name: string; description: string }>; toolOrder: string[];
  };
  let prefix = baseline.tools[0]!.description;
  for (const tool of baseline.tools.slice(1)) {
    let i = 0;
    while (i < prefix.length && prefix[i] === tool.description[i]) i++;
    prefix = prefix.slice(0, i);
  }
  expect(prefix).toHaveLength(19367);
  expect(prefix.endsWith('\n\n')).toBe(true);
  const tools = baseline.tools.map(tool => ({ ...tool, description: tool.description.slice(prefix.length) }));
  const guidance = mcpBootstrapInstructions(capabilityMapText());
  return { baseline, prefix, tools, guidance, exported: mcpToolsWithBootstrap(tools, guidance) };
}

it('context reliability R-7: schema-preservation', () => {
  const { baseline, tools, guidance, exported } = bootstrapReplay();
  expect(exported.map(tool => tool.name)).toEqual(baseline.toolOrder);
  for (const [index, tool] of exported.entries()) {
    const own = tools[index]!.description;
    expect(own).toContain('exec tool declaration:');
    expect(tool.description.endsWith(own)).toBe(true);
    expect(tool.description.slice(tool.description.indexOf('exec tool declaration:')))
      .toBe(own.slice(own.indexOf('exec tool declaration:')));
  }
  expect(exported.filter(tool => tool.description.includes(guidance))).toHaveLength(1);
  expect(exported.find(tool => tool.description.includes(guidance))!.name).toBe('mcp__papercusp_su__tools_find');
  expect(mcpToolsWithBootstrap(exported, guidance)).toEqual(exported);
  const schema = { type: 'object', properties: { row: { type: 'string' } }, required: ['row'] };
  const restricted = [{ name: 'work_items:claim', description: 'claim', inputSchema: schema, _meta: { revision: 'fixture' } }];
  const result = mcpToolsWithBootstrap(restricted, guidance);
  expect(result[0]!.inputSchema).toBe(schema);
  expect(result[0]!._meta).toBe(restricted[0]!._meta);
  expect(restricted[0]!.description).toBe('claim');
  expect(mcpToolsWithBootstrap([], guidance)).toEqual([]);
  expect(mcpToolsWithBootstrap(restricted, undefined)).toEqual(restricted);
});

it('context reliability R-7: pinned-byte-baseline', ({ task }) => {
  const { baseline, prefix, guidance, exported } = bootstrapReplay();
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const before = bytes(JSON.stringify(baseline.tools)), after = bytes(JSON.stringify(exported));
  const duplicatedBefore = (baseline.tools.length - 1) * bytes(prefix);
  const duplicatedAfter = (exported.filter(tool => tool.description.includes(guidance)).length - 1) * bytes(guidance);
  expect(before).toBe(1225418);
  expect(duplicatedBefore).toBeGreaterThan(0);
  expect(duplicatedAfter).toBe(0);
  expect(after).toBeLessThan(before);
  Object.assign(task.meta, { bootstrapReplay: { evidencePlane: 'current-tree-server-export-replay',
    baselineArtifactHash: '986f440eeaf59cf02a400fcd1caf206edae88cc7b04ccd95a91ba29235560ed4',
    tools: exported.length, before, after, duplicatedBefore, duplicatedAfter,
    exportedHash: sha(exported), externalReinsertion: 'UNKNOWN', billedTokens: 'UNKNOWN' } });
});

it('context reliability R-7: contradiction-lint', () => {
  const { guidance } = bootstrapReplay();
  expect(lintInstructionText(guidance).clean).toBe(true);
  expect(guidance).toContain('Catalog entries are discoverable capabilities, not permission grants');
  expect(guidance).toContain('docs:author');
  expect(guidance).toContain('Evidence-only judges use coord:orient {} without intent');
  expect(guidance).not.toContain('WRITE a new/updated MDX');
  expect(guidance).not.toContain('call ANY tool');
});

const nativeExports = new Map<typeof DELIVERY_MATRIX_CLIENTS[number], Promise<BootstrapExportCell>>();
const nativeDiagnostics = new Map<typeof DELIVERY_MATRIX_CLIENTS[number], unknown>();
it('context reliability R-7: nested-request-descriptors', () => {
  const { baseline } = frozenBootstrap();
  const namespace = { type: 'namespace', name: 'offline_canary', description: 'Native MCP namespace',
    tools: baseline.tools.map(tool => ({ type: 'function', ...tool })) };
  const declarations = requestDescriptors([namespace])
    .filter(tool => tool.description.includes('exec tool declaration:'));
  expect(declarations).toEqual(baseline.tools);
  expect(requestDescriptors({ function: { name: 'flat', description: 'Flat declaration' } }))
    .toEqual([{ name: 'flat', description: 'Flat declaration' }]);
  expect(requestDescriptors([null, false, 'description', {}])).toEqual([]);
});

function observeNativeBootstrap(client: typeof DELIVERY_MATRIX_CLIENTS[number]): Promise<BootstrapExportCell> {
  const prior = nativeExports.get(client);
  if (prior) return prior;
  const observation = (async () => {
    const { baseline } = frozenBootstrap();
    const { exported } = bootstrapReplay();
    const before = await captureNativeMcp(client, baseline.tools);
    const after = await captureNativeMcp(client, exported);
    const summary = (capture: typeof before) => ({ clientVersion: capture.clientVersion,
      clientSettings: capture.clientSettings, requestKeys: Object.keys(capture.request),
      descriptors: capture.descriptors.map(tool => ({ name: tool.name, chars: tool.description.length,
        typedDeclaration: tool.description.includes('exec tool declaration:') })) });
    nativeDiagnostics.set(client, { before: summary(before), after: summary(after) });
    expect(after.clientVersion).toBe(before.clientVersion);
    expect(after.clientSettings).toEqual(before.clientSettings);
    return { client, clientVersion: after.clientVersion, evidencePlane: after.evidencePlane,
      before: before.descriptors.filter(tool => tool.description.includes('exec tool declaration:')),
      after: after.descriptors.filter(tool => tool.description.includes('exec tool declaration:')),
      evidenceRefs: [`vitest:context reliability R-7: ${client}-wire`] };
  })();
  nativeExports.set(client, observation);
  return observation;
}

for (const client of DELIVERY_MATRIX_CLIENTS) it(`context reliability R-7: ${client}-wire`, async ({ task }) => {
  const { baseline, exported } = bootstrapReplay();
  const observation = await observeNativeBootstrap(client);
  // Keep the measured shape/configuration even when a later assertion fails.
  Object.assign(task.meta, { bootstrapNativeObservation: nativeDiagnostics.get(client) });
  const prior = observation.before, next = observation.after;
  expect(prior).toHaveLength(55);
  expect(next).toHaveLength(55);
  expect(next.map(tool => tool.name)).toEqual(prior.map(tool => tool.name));
  for (const tool of baseline.tools) {
    expect(prior.filter(row => row.name.endsWith(tool.name) &&
      row.description === bootstrapDescriptionForClient(client, tool.description))).toHaveLength(1);
  }
  for (const tool of exported) {
    expect(next.filter(row => row.name.endsWith(tool.name) &&
      row.description === bootstrapDescriptionForClient(client, tool.description))).toHaveLength(1);
  }
  const beforeText = JSON.stringify(prior), afterText = JSON.stringify(next);
  expect(afterText.split('<!-- papercusp-mcp-bootstrap:v1 -->').length - 1).toBe(1);
  expect(Buffer.byteLength(afterText)).toBeLessThan(Buffer.byteLength(beforeText));
  Object.assign(task.meta, { bootstrapNativeReplay: { client, clientVersion: observation.clientVersion,
    evidencePlane: observation.evidencePlane, baselineHash, toolCount: next.length,
    beforeBytes: Buffer.byteLength(beforeText), afterBytes: Buffer.byteLength(afterText),
    beforeHash: sha(prior), afterHash: sha(next), commonBootstrapCopies: 1, typedContractsPreserved: true,
    descriptionTransform: client === 'claude' ? 'ellipsis-expansion' : 'identity',
    inputSchema: 'owned-empty-object-fixture', productionRuntime: 'UNKNOWN', billedTokens: 'UNKNOWN',
    externalReinsertion: 'UNKNOWN', clientConfiguration: nativeDiagnostics.get(client) } });
}, 90_000);

it('context reliability R-7: claude-omp-export-replay', async ({ task }) => {
  const { baseline, prefix, guidance, exported } = bootstrapReplay();
  const cells = await Promise.all(DELIVERY_MATRIX_CLIENTS.map(observeNativeBootstrap));
  const identity = { planRevision: 32, planHash: '1'.repeat(64), rubricRevision: 3, rubricHash: '2'.repeat(64),
    barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64), runtimeGeneration: 'local-native-fixture-only' };
  const result = validateBootstrapExportArtifact({ schemaVersion: 'bootstrap-export-v1', identity,
    baselineArtifactHash: baselineHash, cells }, { identity, baselineArtifactHash: baselineHash,
    baseline: baseline.tools, exported, oldPrefix: prefix, bootstrap: guidance });
  expect(result).toMatchObject({ valid: true, closed: true });
  Object.assign(task.meta, { bootstrapExportCoverage: { ...result,
    identityKind: 'fixture-only; acceptance identity not asserted', clients: cells.map(cell => ({
      client: cell.client, clientVersion: cell.clientVersion, evidencePlane: cell.evidencePlane,
      beforeHash: sha(cell.before), afterHash: sha(cell.after), evidenceRefs: cell.evidenceRefs })) } });
}, 90_000);

it('context reliability R-7: artifact-validator', () => {
  const { baseline, prefix, guidance, exported } = bootstrapReplay();
  const identity = { planRevision: 32, planHash: '1'.repeat(64), rubricRevision: 3, rubricHash: '2'.repeat(64),
    barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64), runtimeGeneration: 'validator-fixture-only' };
  const cells: BootstrapExportCell[] = DELIVERY_MATRIX_CLIENTS.map(client => ({ client, clientVersion: 'fixture-only',
    evidencePlane: client === 'omp' ? 'installed-client-registration' : 'installed-client-local-request',
    before: baseline.tools.map(tool => ({ ...tool, description: bootstrapDescriptionForClient(client, tool.description) })),
    after: exported.map(tool => ({ ...tool, description: bootstrapDescriptionForClient(client, tool.description) })),
    evidenceRefs: ['validator-control-fixture'] }));
  const artifact: BootstrapExportArtifact = { schemaVersion: 'bootstrap-export-v1', identity, baselineArtifactHash: baselineHash, cells };
  const oracle = { identity, baselineArtifactHash: baselineHash, baseline: baseline.tools, exported, oldPrefix: prefix, bootstrap: guidance };
  expect(validateBootstrapExportArtifact(artifact, oracle)).toMatchObject({ valid: true, closed: true });
  const reject = (mutate: (copy: BootstrapExportArtifact) => void) => {
    const copy = structuredClone(artifact); mutate(copy);
    expect(validateBootstrapExportArtifact(copy, oracle).valid).toBe(false);
  };
  reject(copy => { copy.cells.pop(); });
  reject(copy => { copy.cells.push(copy.cells[0]!); });
  reject(copy => { copy.cells[0]!.client = 'unknown' as never; });
  reject(copy => { copy.cells[0]!.clientVersion = ''; });
  reject(copy => { copy.cells[0]!.evidencePlane = 'installed-client-registration'; });
  reject(copy => { copy.baselineArtifactHash = 'a'.repeat(64); });
  reject(copy => { copy.identity.sourceHash = 'b'.repeat(64); });
  reject(copy => { copy.cells[0]!.after.pop(); });
  reject(copy => { copy.cells[0]!.after[0]!.name = 'wrong'; });
  reject(copy => { copy.cells[0]!.after[0]!.description += '\nchanged contract'; });
  reject(copy => { copy.cells[1]!.before[0]!.description = copy.cells[1]!.before[0]!.description.slice(0, -1); });
  reject(copy => { copy.cells[1]!.after[0]!.description += '\nchanged contract'; });
  reject(copy => { copy.cells[0]!.after[0]!.description += guidance; });
  reject(copy => { copy.cells[0]!.after = copy.cells[0]!.before; });
  reject(copy => { copy.cells[0]!.evidenceRefs = []; });
  expect(validateBootstrapExportArtifact(null, oracle).valid).toBe(false);
});

it('observes the installed OMP registration and mounted route without inference', async () => {
  const result = await captureNativeMcp('omp', [{ name: 'echo', description: 'Offline registration canary.' }]);
  expect(result.methods).toContain('initialize');
  expect(result.methods).toContain('tools/list');
  expect(result.descriptors).toEqual([{ name: 'mcp__offline_canary_echo', description: 'Offline registration canary.' }]);
  expect(result.evidencePlane).toBe('installed-client-registration');
}, 45_000);

for (const client of ['codex', 'claude'] as const) for (const kind of ['memory', 'corpus'] as const)
  for (const port of ['initialize', 'orient', 'claim', 'create'] as const)
  it(`context reliability R-1: installed ${client} ${kind} ${port} stdout`, async ({ task }) => {
    const instructions = `Native ${kind} receipt canary.\nApproval is required after the final condition ☃`;
    const capture = await captureNativeMcp(client, [{ name: 'receipt_canary', description: 'Local receipt observation.' }],
      instructions, [], { stdioReceipt: kind, stdioPort: port });
    expect(capture.methods).toEqual(expect.arrayContaining(['initialize', 'tools/list']));
    if (port !== 'initialize') expect(capture.methods).toContain('tools/call');
    // Two independent boundaries: the installed client's provider request
    // contains the body AND the maintained stdio adapter saved its exact hash.
    // Neither a prepared instruction nor a metadata-only offer suffices.
    const visible = port === 'initialize' ? instructions : JSON.stringify({ [port]: instructions });
    expect(JSON.stringify(capture.request)).toContain(JSON.stringify(visible).slice(1, -1));
    expect(capture.stdoutDelivery).toEqual({ adapter: 'ptool-stdio', owner: `su-native-receipt-${client}`,
      confirmations: [{ token: `native-${port}-${client}`, fragments: [{ kind, id: `native-${kind}`,
        epoch: 3, port, bodySha256: sha256(instructions), bodyBytes: Buffer.byteLength(instructions) }] }] });
    Object.assign(task.meta, { nativeMcpDelivery: { client, port, clientVersion: capture.clientVersion,
      clientSettings: capture.clientSettings, ...capture.stdoutDelivery,
      evidencePlane: 'installed-client-local-request', productionRuntime: 'UNKNOWN',
      scope: 'stdio adapter and installed client; fixture source/envelopes/recipient; no production port or deployment claim' } });
  }, 45_000);

it('refuses to present the in-process OMP route as a ptool stdout profile', async () => {
  await expect(captureNativeMcp('omp', [{ name: 'echo', description: 'Unchanged registration.' }],
    'Complete instructions', [], { stdioReceipt: 'memory' })).rejects.toThrow('requires Codex/Claude');
});

it('context reliability R-7: claude-default-description-observation', async ({ task }) => {
  const description = 'Native default-budget canary. ' + 'x'.repeat(3500) + ' CONTRACT_END';
  const capture = await captureNativeMcp('claude', [{ name: 'description_canary', description }],
    undefined, [], { claudeDescriptionMode: 'default' });
  const tool = capture.descriptors.find(row => row.name.endsWith('description_canary'));
  Object.assign(task.meta, { claudeDefaultDescriptionObservation: {
    clientVersion: capture.clientVersion, clientSettings: capture.clientSettings,
    suppliedChars: description.length, observedChars: tool?.description.length ?? null,
    truncated: tool ? tool.description !== description : 'UNKNOWN',
    fullSchemaParity: 'NOT_ASSERTED', productionRuntime: 'UNKNOWN',
  } });
  expect(capture.clientSettings).toEqual({ toolSearch: 'disabled', descriptionMode: 'default' });
  expect(tool?.description).toContain('Native default-budget canary.');
  if (tool?.description !== description) expect(tool?.description).toContain('[truncated]');
}, 45_000);

it('context reliability R-7: claude-full-description-observation', async ({ task }) => {
  // This independent literal canary keeps the native punctuation oracle honest.
  const capture = await captureNativeMcp('claude', [{ name: 'punctuation_canary',
    description: 'Native punctuation: …; contract: { value: string }' }]);
  const tool = capture.descriptors.find(row => row.name.endsWith('punctuation_canary'));
  expect(tool?.description).toBe('Native punctuation: ...; contract: { value: string }');
  const { baseline } = frozenBootstrap();
  const longest = Math.max(...baseline.tools.map(row => row.description.replaceAll('…', '...').length));
  expect(capture.clientSettings.maxMcpDescriptionChars).toBe(longest);
  Object.assign(task.meta, { claudeFullDescriptionObservation: {
    clientVersion: capture.clientVersion, clientSettings: capture.clientSettings,
    descriptionTransform: 'ellipsis-expansion', productionRuntime: 'UNKNOWN',
  } });
}, 45_000);
