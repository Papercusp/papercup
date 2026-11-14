---
rel_path: "portability/census/v41/01-state-census-producers.ts.part-006"
updated_at: 1794241756285
_body: "content"
---

ccount checks, result construction, the final write and printed receipt.
 */
export function historicalStripeConfigConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  for (const statement of outer.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
      statement.expression.expression.getText(outer) !== 'text' || statement.expression.arguments.length !== 1) return null;
    const awaited = statement.expression.arguments[0];
    if (!ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return null;
    const call = awaited.expression;
    if (call.arguments.length !== 1 || !ts.isObjectLiteralExpression(call.arguments[0])) return null;
    const properties = call.arguments[0].properties;
    const literal = (name: string) => {
      const matches = properties.filter(property => ts.isPropertyAssignment(property) && property.name.getText(outer) === name);
      return matches.length === 1 && ts.isPropertyAssignment(matches[0]) && ts.isStringLiteralLike(matches[0].initializer)
        ? matches[0].initializer.text : null;
    };
    switch (call.expression.getText(outer)) {
      case 'tools.exec_command': {
        const command = literal('cmd');
        if (command === null) return null;
        commands.push(command);
        break;
      }
      case 'tools.write_stdin': if (literal('chars') !== '') return null; break;
      case 'tools.mcp__papercusp_su__tools_invoke':
        if (!['rubrics:propose', 'locks:acquire'].includes(literal('name') ?? '')) return null;
        break;
      default: return null;
    }
  }
  if (commands.length !== 1) return null;
  const program = commands[0].match(/^python3 - <<'PY'\n([\s\S]*)\nPY$/)?.[1];
  if (!program) return null;
  const key = program.match(/^key=Path\('([^'\n]+)'\)\.read_text\(\)\.strip\(\)$/m)?.[1];
  const secret = program.match(/^securewrite\('([^'\n]+)',hook\['secret'\]\+'\\n'\)$/m)?.[1];
  const output = program.match(/^securewrite\('([^'\n]+)',json\.dumps\(result,indent=2\)\+'\\n'\)$/m)?.[1];
  if (!key || !secret || !output || new Set([key, secret, output]).size !== 3 ||
    dirname(key) !== join(home, '.papercusp', 'secrets') || dirname(secret) !== dirname(key) ||
    dirname(output) !== join(home, '.config', 'papercusp')) return null;
  const normalized = program.replaceAll(key, 'KEY').replaceAll(secret, 'WEBHOOK_SECRET').replaceAll(output, 'DESTINATION');
  if (createHash('sha256').update(normalized).digest('hex') !== 'da6deb2c614f4489b872a79fcd08aae8085265c1cfdd825ddeb550d529cdcd88') return null;
  return { output, accountId: program.match(/^ACCOUNT='([^']+)'$/m)![1] };
}

/** A successful receipt transports content; only matching installed bytes admit it.
 * No keys, configuration values or archived executable source enter the census.
 */
export async function historicalStripeConfigCensusProducer(evidence: readonly PlaywrightStateWriterEvidence[], home = homedir()) {
  const roots: CensusRoot[] = []; const declarations: CensusDeclaration[] = [];
  if (evidence.length > 100) throw new Error('Stripe configuration evidence bound exceeded');
  for (const record of evidence) {
    const construction = historicalStripeConfigConstruction(record.toolInput, home);
    const from = Date.parse(record.startedAt); const to = Date.parse(record.finishedAt);
    if (!construction || !record.ref || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 300_000) continue;
    const recovered = historicalCensusReceipt(record.receipt);
    if (!recovered) continue;
    const receipt = JSON.parse(recovered);
    if (Object.keys(receipt).sort().join() !== 'accountId,accountName,mode,plans,portalConfigurationId,webhookEndpointId,webhookUrl,workItem' ||
      receipt.accountId !== construction.accountId || receipt.accountName !== 'Papercusp LLC' || receipt.workItem !== 'WI-10005826' ||
      receipt.webhookUrl !== 'https://app.papercusp.com/api/hosted/billing/webhook' ||
      !receipt.plans.every((plan: Record<string, unknown>) => Object.keys(plan).sort().join() === 'description,label,planKey,priceId,productId')) continue;
    // Python json.dumps(indent=2) defaults to ensure_ascii=True. These fields
    // contain strings only, so escaping UTF-16 code units also covers astral text.
    const expected = Buffer.from(JSON.stringify(receipt, null, 2).replace(/[\u007f-\uffff]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n');
    if (expected.length > 1_048_576) continue;
    let handle;
    try {
      if (await realpath(dirname(construction.output)) !== dirname(construction.output)) continue;
      handle = await open(construction.output, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expected.length || (stat.mode & 0o777) !== 0o600 || stat.mtimeMs < from || stat.mtimeMs > to) continue;
      if (!(await handle.readFile()).equals(expected)) continue;
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || (after.mode & 0o777) !== 0o600) continue;
      const root: CensusRoot = { id: `stripe-config-${roots.length}`, path: dirname(construction.output) };
      roots.push(root); declarations.push({ kind: 'path', root: root.id, name: basename(construction.output),
        classification: 'secret', producer: `historical-stripe-test-config:${record.ref}` });
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally { await handle?.close(); }
  }
  return { roots, declarations };
}

/** Native exec can print a completed shell envelope instead of its stdout.
 * Only unwrap the documented successful terminal envelope; a yielded handle,
 * failed command, or arbitrary nested object is not a writer receipt.
 */
function historicalCensusReceipt(text: string): string | null {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if ('exit_code' in value || 'session_id' in value) {
    if (value.exit_code !== 0 || 'session_id' in value || typeof value.output !== 'string') return null;
    try { value = JSON.parse(value.output); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  }
  // Preserve the complete historical configuration, not a path-only summary.
  // Recovery is evidence transport; installed-content admission remains separate.
  const stripeConfig = value.mode === 'test' && typeof value.accountId === 'string' &&
    value.accountId.startsWith('acct_') && typeof value.accountName === 'string' &&
    Array.isArray(value.plans) && value.plans.length > 0 &&
    value.plans.every((plan: Record<string, unknown>) => plan && typeof plan === 'object' &&
      ['planKey', 'priceId', 'productId', 'label', 'description'].every(key => typeof plan[key] === 'string')) &&
    ['portalConfigurationId', 'webhookEndpointId', 'webhookUrl', 'workItem'].every(key => typeof value[key] === 'string');
  return stripeConfig || value.storageState !== undefined ||
    (value.ok === true && typeof value.statePath === 'string' && typeof value.sessionHash === 'string')
    ? JSON.stringify(value) : null;
}

/** The search index locates a session/time; it is not the complete source.
 * Reuse the session-port reader's manifest, bounded decompression and SHA checks.
 * Pair calls by call_id, never by adjacent lines/parts (outputs can interleave).
 */
export async function recoverHistoricalCensusWriterEvidence(candidates: readonly IndexedCensusWriterEvidence[],
  readArchive: (sessionId: string) => Promise<{ bytes: Buffer; sha256: string }> = async sessionId => {
    const { readCanonicalNativeArchive } = await import('../session-port/source');
    const { pgSessionArchiveStore } = await import('../session-archive');
    return readCanonicalNativeArchive({ backend: 'codex', sessionId }, pgSessionArchiveStore());
  }): Promise<PlaywrightStateWriterEvidence[]> {
  if (candidates.length > 100) throw new Error('Historical census evidence bound exceeded');
  const result: PlaywrightStateWriterEvidence[] = [];
  for (const sessionId of new Set(candidates.map(candidate => candidate.sessionId))) {
    let source;
    try { source = await readArchive(sessionId); }
    catch (error) {
      if (error instanceof Error && error.message === 'canonical codex archive not found') continue;
      throw error;
    }
    if (source.bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(source.bytes).digest('hex') !== source.sha256) throw new Error('Historical census archive SHA/size mismatch');
    const selected = candidates.filter(candidate => candidate.sessionId === sessionId);
    const calls = new Map<string, { input: string; timestamp: string; line: number }>();
    const outputs = new Map<string, { output: unknown; timestamp: string }>();
    const duplicate = new Set<string>();
    let line = 0;
    for (const raw of source.bytes.toString('utf8').split('\n')) {
      line++;
      if (!raw.trim()) continue;
      let record;
      try { record = JSON.parse(raw); } catch { throw new Error('Historical census archive JSONL malformed'); }
      const payload = record?.payload;
      if (record?.type !== 'response_item' || typeof payload?.call_id !== 'string') continue;
      if (['custom_tool_call', 'function_call'].includes(payload.type) && payload.name === 'exec' &&
        selected.some(candidate => Date.parse(candidate.startedAt) === Date.parse(record.timestamp))) {
        let input = payload.input ?? payload.arguments;
        if (payload.type === 'function_call' && typeof input === 'string') {
          try { const args = JSON.parse(input); if (typeof args.code === 'string') input = args.code; } catch { /* Raw code is also a native dialect. */ }
        }
        if (typeof input !== 'string' || input.length > 65_536) continue;
        if (calls.has(payload.call_id)) duplicate.add(payload.call_id);
        calls.set(payload.call_id, { input, timestamp: record.timestamp, line });
      }
      if (['custom_tool_call_output', 'function_call_output'].includes(payload.type)) {
        if (outputs.has(payload.call_id)) duplicate.add(payload.call_id);
        outputs.set(payload.call_id, { output: payload.output, timestamp: record.timestamp });
      }
    }
    for (const [callId, call] of calls) {
      const output = outputs.get(callId);
      if (!output || duplicate.has(callId)) continue;
      const texts = typeof output.output === 'string' ? [output.output] : Array.isArray(output.output)
        ? output.output.flatMap(block => typeof block?.text === 'string' ? [block.text] : []) : [];
      const receipts = texts.flatMap(text => {
        const receipt = historicalCensusReceipt(text);
        return receipt === null ? [] : [receipt];
      });
      if (result.length >= 100) throw new Error('Historical census recovered call bound exceeded');
      result.push({ ref: `archive:codex:${sessionId}:sha256:${source.sha256}:line:${call.line}:call:${callId}`,
        indexedRef: selected.find(candidate => Date.parse(candidate.startedAt) === Date.parse(call.timestamp))?.ref,
        toolInput: call.input, startedAt: call.timestamp, finishedAt: output.timestamp,
        receipt: receipts.length === 1 ? receipts[0] : '' });
    }
  }
  return result;
}

/** Receipt, complete writer, private file metadata and storage-state schema must
 * agree. A filename or an indexed/truncated command alone proves nothing.
 */
export async function historicalPlaywrightStateCensusProducer(evidence: readonly PlaywrightStateWriterEvidence[], home = homedir()) {
  const roots: CensusRoot[] = []; const declarations: CensusDeclaration[] = [];
  if (evidence.length > 100) throw new Error('Playwright state evidence bound exceeded');
  for (const record of evidence) {
    const construction = historicalPlaywrightStateConstruction(record.toolInput, home);
    const from = Date.parse(record.startedAt); const to = Date.parse(record.finishedAt);
    if (!construction || !record.ref || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 300_000) continue;
    let receipt;
    try { receipt = JSON.parse(record.receipt); } catch { continue; }
    if (!receipt || typeof receipt !== 'object' || receipt.final?.host !== 'app.papercusp.com' || receipt.final?.path !== '/cloud-workspaces' ||
      receipt.session?.status !== 200 || receipt.session?.ok !== true || receipt.session?.error !== null ||
      receipt.storageState?.path !== construction.output || receipt.storageState?.mode !== '600' ||
      !Number.isSafeInteger(receipt.storageState?.bytes) || receipt.storageState.bytes <= 0 || receipt.storageState.bytes > 1_048_576) continue;
    let handle;
    try {
      if (await realpath(dirname(construction.output)) !== dirname(construction.output)) continue;
      handle = await open(construction.output, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== receipt.storageState.bytes || (stat.mode & 0o777) !== 0o600 ||
        stat.mtimeMs < from || stat.mtimeMs > to) continue;
      const state = JSON.parse(await handle.readFile('utf8'));
      if (!state || typeof state !== 'object' || Object.keys(state).sort().join() !== 'cookies,origins' || !Array.isArray(state.cookies) || !state.cookies.length || !Array.isArray(state.origins)) continue;
      if (!state.cookies.every((cookie: Record<string, unknown>) => cookie && typeof cookie === 'object' && typeof cookie.name === 'string' && typeof cookie.value === 'string' &&
        typeof cookie.domain === 'string' && typeof cookie.path
