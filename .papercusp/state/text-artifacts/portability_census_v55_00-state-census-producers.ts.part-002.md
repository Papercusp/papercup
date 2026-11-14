---
rel_path: "portability/census/v55/00-state-census-producers.ts.part-002"
updated_at: 1794250602744
_body: "content"
---

)\+'\\n'\)$/m)?.[1];
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
        typeof cookie.domain === 'string' && typeof cookie.path === 'string' && typeof cookie.expires === 'number' && Number.isFinite(cookie.expires) &&
        typeof cookie.httpOnly === 'boolean' && typeof cookie.secure === 'boolean' && ['Strict', 'Lax', 'None'].includes(String(cookie.sameSite)))) continue;
      if (!state.cookies.some((cookie: { domain: string }) => ['app.papercusp.com', '.papercusp.com'].includes(cookie.domain))) continue;
      if (!state.origins.every((origin: { origin?: unknown; localStorage?: unknown }) => origin && typeof origin === 'object' && typeof origin.origin === 'string' &&
        Array.isArray(origin.localStorage) && origin.localStorage.every(value => typeof value?.name === 'string' && typeof value?.value === 'string'))) continue;
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || (after.mode & 0o777) !== 0o600) continue;
      const root: CensusRoot = { id: `playwright-state-${roots.length}`, path: dirname(construction.output) };
      roots.push(root); declarations.push({ kind: 'path', root: root.id, name: basename(construction.output),
        classification: 'secret', producer: `historical-playwright-storage-state:${record.ref}` });
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') && !(error instanceof SyntaxError)) throw error;
    } finally { await handle?.close(); }
  }
  return { roots, declarations };
}

/** Extend the hosted surface with content-proven historical destinations only.
 * The input's own provenance remains independent: consuming it is not creating it.
 * Decrypted values never leave this function or appear in the census manifest.
 */
export async function historicalHostedProfileCensusProducer(evidence: readonly HostedProfileWriterEvidence[],
  home = homedir(), readerPath = join(moduleRepoRoot(import.meta.url), 'node_modules/verdict-cli/src/server.mjs')) {
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  if (evidence.length > 100) throw new Error('Hosted profile evidence bound exceeded');
  if (!evidence.length) return { roots, declarations };
  let reader: string;
  try { reader = await readFile(readerPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { roots, declarations }; throw error; }
  const expectedReader = `const MACHINE_KEY = scryptSync(\
    \`\${hostname()}-\${userInfo().username}-verdict-cli\`, 'verdict-cli-salt-v1', 32);
function encryptData(data) { const iv = randomBytes(16); const cipher = createCipheriv('aes-256-cbc', MACHINE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') }); }
function decryptData(raw) { const { iv, data } = JSON.parse(raw);
  const decipher = createDecipheriv('aes-256-cbc', MACHINE_KEY, Buffer.from(iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')); }`;
  const start = reader.indexOf('const MACHINE_KEY =');
  const end = reader.indexOf('function profilePath', start);
  if (start < 0 || end < 0 || sourceTokens(reader.slice(start, end)) !== sourceTokens(expectedReader)) return { roots, declarations };
  const privateFile = async (path: string) => {
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1_048_576 || (stat.mode & 0o777) !== 0o600) return null;
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  };
  const key = scryptSync(`${hostname()}-${userInfo().username}-verdict-cli`, 'verdict-cli-salt-v1', 32);
  for (const record of evidence) {
    const construction = historicalHostedProfileConstruction(record.toolInput, home);
    const from = Date.parse(record.startedAt); const to = Date.parse(record.finishedAt);
    if (!construction || !record.ref || !Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 300_000) continue;
    try { if (await realpath(dirname(construction.output)) !== dirname(construction.output)) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const input = await privateFile(construction.input); const output = await privateFile(construction.output);
    if (input === null || output === null) continue;
    try {
      const state = JSON.parse(input); const envelope = JSON.parse(output);
      if (Object.keys(envelope).sort().join() !== 'data,iv' || typeof envelope.iv !== 'string' || !/^[0-9a-f]{32}$/.test(envelope.iv) ||
        typeof envelope.data !== 'string' || !/^(?:[0-9a-f]{32})+$/.test(envelope.data)) continue;
      const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(envelope.iv, 'hex'));
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()]).toString('utf8'));
      const savedAt = Date.parse(value.savedAt);
      if (Object.keys(value).sort().join() !== 'cookies,savedAt,storage,url' || !Array.isArray(state.cookies) ||
        JSON.stringify(value.cookies) !== JSON.stringify(state.cookies) || value.url !== construction.url ||
        JSON.stringify(value.storage) !== '{"localStorage":{},"sessionStorage":{}}' || !Number.isFinite(savedAt) || savedAt < from || savedAt > to) continue;
      const root: CensusRoot = { id: `hosted-profile-${roots.length}`, path: dirname(construction.output) };
      roots.push(root);
      declarations.push({ kind: 'path', root: root.id, name: basename(construction.output), classification: 'secret', producer: `historical-hosted-profile:${record.ref}` });
    } catch { /* Corrupt or nonmatching content supplies no ownership proof. */ }
  }
  return { roots, declarations };
}

/** The keychain directory is sensitive retained material, never rebuildable. */
export function identityKeychainCensusProducer() {
  const path = identityDir();
  return { roots: [{ id: 'identity-keychain-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'identity-keychain-parent', name: basename(path),
    classification: 'secret' as const, producer: 'identity-keychain', descendants: true,
  }] };
}

export function anchorSecretCensusProducer() {
  const path = anchorKeyFilePath();
  return { roots: [{ id: 'anchor-key-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'anchor-key-parent', name: basename(path),
    classification: 'secret' as const, producer: 'ledger-anchor-key',
  }] };
}

/** Operator database selection is configuration evidence, not name matching. */
export function configuredOperatorDatabaseCensusDeclarations(clusterIdentity: string, operatorUrl: string): CensusDeclaration[] {
  if (!/^postgres-cluster:\d+$/.test(clusterIdentity)) throw new Error('Missing physical operator cluster identity');
  const database = decodeURIComponent(new URL(operatorUrl).pathname.slice(1));
  if (!database || database.includes('/')) throw new Error('Missing operator database identity');
  return [{ kind: 'database', root: clusterIdentity, name: database, classification: 'state', producer: 'embedded-pg-discovery-operator' },
    { kind: 'database', root: clusterIdentity, name: 'papercusp_su', classification: 'state', producer: 'su-lock-store' }];
}

/** Resolve service database configuration, without emitting credentials.
 * Unsupported specifiers and externally hosted databases remain unclassified.
 */
export async function unitDatabaseCensusDeclarations(units: readonly CensusDeclaration[], databases: readonly CensusEntry[], operatorUrl: string, environmentRoots?: readonly string[]): Promise<CensusDeclaration[]> {
  const operator = new URL(operatorUrl);
  const host = (value: string) => ['localhost', '127.0.0.1', '[::1]'].includes(value) ? 'loopback' : value;
  const result: CensusDeclaration[] = [];
  for (const unit of units) {
    if (unit.kind !== 'unit' || !unit.name.endsWith('.service') || unit.name.includes('/') || !unit.producer.startsWith('unit-definition:')) continue;
    const path = join(unit.producer.slice('unit-definition:'.length), unit.name);
    let handle;
    try {
      if (!(await lstat(path)).isFile()) continue;
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      // Transient units can disappear after catalogue discovery or lstat.
      // No surviving definition means no database ownership evidence.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let text: string;
    try {
      if ((await handle.stat()).size > 65_536) throw new Error('Service database config bound exceeded');
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
    const environment = parseUnitEnvironment(text);
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^EnvironmentFile=(-?)(.*)$/);
      if (!match) continue;
      const file = match[2].trim().replace(/^["']|["']$/g, '').replace(/%h/g, homedir());
      if (!isAbsolute(file) || file.includes('%')) continue;
      // Platform census scope does not authorize inspecting arbitrary OS service
      // credentials. Out-of-scope environment files provide no ownership proof.
      const allowed = environmentRoots ?? [dirname(path)];
      if (!allowed.some(root => {
        const suffix = relative(root, file);
        return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
      })) continue;
      let fileHandle;
      try { fileHandle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (match[1] === '-' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try {
        const stat = await fileHandle.stat();
        if (!stat.isFile() || stat.size > 65_536) throw new Error('Service environment file bound exceeded');
        const contents = await fileHandle.readFile('utf8');
        Object.assign(environment, parseUnitEnvironment(contents.split('\n').filter(row =>
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(row.trim())).map(row => `Environment=${row.trim()}`).join('\n')));
      } finally { await fileHandle.close(); }
    }
    for (const [key, value] of Object.entries(environment)) {
      if (!(key === 'DATABASE_URL' || key.endsWith('_DATABASE_URL'))) continue;
      let url;
      try { url = new URL(value); } catch { continue; }
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || host(url.hostname) !== host(operator.hostname) ||
        (url.port || '5432') !== (operator.port || '5432')) continue;
      const name = decodeURIComponent(url.pathname.slice(1));
      const entry = databases.find(database => database.kind === 'database' && database.name === name);
      if (entry) result.push({ ...entry, classification: 'state', producer: `unit-database-config:${unit.root}:${unit.name}:${key}` });
    }
  }
  return result;
}

/**
 * Read the actual cluster catalog, including disconnected databases. Classification
 * belongs to each database producer; an unexpected DB remains census residue.
 * Cluster identity is supplied explicitly so equal names on two clusters never alias.
 */
export async function databaseCensusEntries(sql: Sql, clusterIdentity: string): Promise<CensusEntry[]> {
  if (!clusterIdentity.trim()) throw new Error('Missing census cluster identity');
  const rows = await sql<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname
  `;
  return rows.map(row => ({ kind: 'database', root: clusterIdentity, name: row.datname }));
}

/** Resolve the same physical cluster identity used by backup receipt coverage. */
export async function physicalDatabaseCensusEntries(sql: Sql) {
  const rows = await sql<{ system_identifier: string }[]>`
    SELECT system_identifier::text FROM pg_control_system()
  `;
  const identity = rows[0]?.system_identifier;
  if (!identity || !/^\d+$/.test(identity)) throw new Error('Unavailable physical database cluster identity');
  return databaseCensusEntries(sql, `postgres-cluster:${identity}`);
}

/** initdb's fixed PostgresDbOid and catalog comment identify its maintenance DB.
 * Retain the entire database, including any application objects added later.
 * Source: PostgreSQL src/bin/initdb/initdb.c make_postgres; pg_database_d.h.
 */
export async function maintenanceDatabaseCensusDeclarations(sql: Sql, clusterIdentity: string): Promise<CensusDeclaration[]> {
  if (!/^postgres-cluster:\d+$/.test(clusterIdentity)) throw new Error('Missing physical maintenance cluster identity');
  const identity = await sql<{ system_identifier: string }[]>`SELECT system_identifier::text FROM pg_control_system()`;
  if (`postgres-cluster:${identity[0]?.system_identifier}` !== clusterIdentity) throw new Error('Maintenance database cluster identity mismatch');
  const rows = await sql<{ oid: number; datname: string; datistemplate: boolean; marker: string }[]>`
    SELECT oid, datname, datistemplate, shobj_description(oid, 'pg_database') AS marker
    FROM pg_database WHERE oid = 5
  `;
  return rows.filter(row => row.oid === 5 && row.datname === 'postgres' && row.datistemplate === false &&
    row.marker === 'default administrative connection database').map(row => ({
      kind: 'database', root: clusterIdentity, name: row.datname, classification: 'state', producer: 'postgres-initdb-maintenance',
    }));
}

/** Only the exact integration-baseline identity shape emitted by its producer. */
export function integrationBaselineCensusDeclarations(entries: readonly CensusEntry[]): CensusDeclaration[] {
  return entries.filter(entry => entry.kind === 'database' &&
    /^papercusp_it_baseline_[0-9a-f]{12}$/.test(entry.name)).map(entry => ({
      ...entry, classification: 'dev-only', producer: 'baseline-schema-global-setup',
    }));
}

/** The integration template builder stamps readiness in the shared PG catalog. */
export async function templateDatabaseCensusDeclarations(sql: Sql, clusterIdentity: string): Promise<CensusDeclaration[]> {
  if (!clusterIdentity.startsWith('postgres-cluster:') || !/^\d+$/.test(clusterIdentity.slice('postgres-cluster:'.length))) throw new Error('Missing physical template cluster identity');
  const rows = await sql<{ datname: string; marker: string }[]>`
    SELECT datname, shobj_description(oid, 'pg_database') AS marker FROM pg_database
    WHERE starts_with(datname, 'tmpl_') AND shobj_description(oid, 'pg_database') = 'pc-template-ready'
  `;
  return rows.filter(row => row.datname.startsWith('tmpl_') && row.marker === 'pc-template-ready')
    .map(row => ({ kind: 'database', root: clusterIdentity, name: row.datname, classification: 'dev-only', producer: 'pg-migrate-template-ready' }));
}

let execFileAsyncMemo: typeof execFile.__promisify__ | null = null;
const execFileAsync = ((...args: unknown[]) =>
  Reflect.apply((execFileAsyncMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
/** Read complete literal migration arrays without executing application code. */
function literalMigrationStatements(source: string): string[] {
  const file = ts.createSourceFile('migrations.ts', source, ts.ScriptTarget.Latest, true);
  const statements: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer) || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression;
      if (!ts.isIdentifier(declaration.name) || !declaration.name.text.endsWith('_MIGRATIONS') ||
        !initializer || !ts.isArrayLiteralExpression(initializer)) continue;
      if (initializer.elements.some(element => !ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element))) continue;
      statements.push(...initializer.elements.map(element => (element as ts.StringLiteralLike).text));
    }
  }
  return statements;
}

export function migrationProducerTables(source: string): string[] {
  return [...new Set(literalMigrationStatements(source).flatMap(statement => {
    const match = statement.match(/^\s*CREATE TABLE(?: IF NOT EXISTS)? ([a-z_][a-z0-9_]*)\s*\(/i);
    return match ? [`public.${match[1].toLowerCase()}`] : [];
  }))];
}

/** Bound history to this registered repository and this exact regular-file path.
 * Historical schemas require columns/types, never an arbitrary table overlap.
 */
async function historicalProjectMigrationSources(repository: string, producer: string): Promise<MigrationCensusSource[]> {
  const options = { timeout: 5000, maxBuffer: 4 * 1024 * 1024 };
  let root: string;
  try { root = (await execFileAsync('git', ['-C', repository, 'rev-parse', '--show-toplevel'], options)).stdout.trim(); }
  catch (error) {
    if ((error as { code?: number | string }).code === 128) return [];
    throw error;
  }
  if (resolve(root) !== resolve(repository)) return [];
  const name = 'packages/data/src/migrations.ts';
  const { stdout } = await execFileAsync('git', ['-C', repository, 'log', '--all', '--max-count=128',
    '--format=', '--raw', '--no-abbrev', '--no-renames', '-z', '--', name], options);
  const fields = stdout.split('\0');
  const blobs = new Set<string>();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const match = /^:\d{6} 100(?:644|755) [0-9a-f]+ ([0-9a-f]+) [AMT]$/.exec(fields[index].trim());
    if (match && fields[index + 1] === name) blobs.add(match[1]);
  }
  const sources: MigrationCensusSource[] = [];
  const schemas = new Set<string>();
  for (const blob of blobs) {
    const size = Number((await execFileAsync('git', ['-C', repository, 'cat-file', '-s', blob], options)).stdout.trim());
    if (!Number.isSafeInteger(size) || size <= 0 || size > 1_048_576) continue;
    const text = (await execFileAsync('git', ['-C', repository, 'cat-file', 'blob', blob], options)).stdout;
    // Functions, prose and ALTER statements cannot introduce CREATE evidence.
    const sql = literalMigrationStatements(text).filter(statement => /^\s*CREATE\s+TABLE\b/i.test(statement)).join(';\n');
    const source = sqlMigrationCensusSource(sql, `${producer}:git-blob:${blob}:${name}`);
    if (!source) continue;
    const identity = JSON.stringify([source.tables, source.columns]);
    if (!schemas.has(identity)) { schemas.add(identity); sources.push(source); }
  }
  return sources;
}

/** Read literal app migrations from canonical registered project paths without executing source. */
export async function registeredProjectMigrationSources(projects: readonly { slug: string; path: string }[], units: readonly CensusDeclaration[] = []): Promise<MigrationCensusSource[]> {
  const sources: MigrationCensusSource[] = [];
  const roots = [...projects];
  // Installed definitions establish source locations; service names carry no
  // classification authority. Never inspect EnvironmentFile credential values.
  for (const unit of units) {
    if (unit.kind !== 'unit' || !unit.name.endsWith('.service') || unit.name.includes('/') || !unit.producer.startsWith('unit-definition:')) continue;
    const body = await boundedSource(join(unit.producer.slice('unit-definition:'.length), unit.name), 65_536);
    if (!body) continue;
    let section = '';
    let workingDirectory: string | undefined;
    for (const line of body.split('\n')) {
      const heading = line.trim().match(/^\[([^\]]+)\]$/);
      if (heading) { section = heading[1]; continue; }
      const match = section === 'Service' && line.trim().match(/^WorkingDirectory=(.*)$/);
      if (!match) continue;
      const value = match[1].trim().replace(/^"([^"\n]*)"$/, '$1').replace(/%h/g, homedir());
      workingDirectory = isAbsolute(value) && !/[\n%\\]/.test(value) ? value : undefined;
    }
    if (workingDirectory) roots.push({ slug: `unit:${unit.root}:${unit.name}`, path: workingDirectory });
  }
  const seen = new Set<string>();
  for (const project of roots) {
    if (seen.has(project.path)) continue;
    seen.add(project.path);
    const path = join(project.path, 'packages', 'data', 'src', 'migrations.ts');
    const literalMigrations = await boundedSource(path);
    if (literalMigrations) {
      const tables = migrationProducerTables(literalMigrations);
      if (tables.length >= 2) sources.push({ producer: `app-migrations:registry:${project.slug}:${project.path}`, tables });
      sources.push(...await historicalProjectMigrationSources(project.path, `app-migrations:registry:${project.slug}:${project.path}`));
    }
    const config = await boundedSource(join(project.path, 'drizzle.config.ts'));
    const output = config && literalDrizzleOutput(config);
    if (!output) continue;
    const directory = resolve(project.path, output);
    const suffix = relative(project.path, directory);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) continue;
    try {
      if (await realpath(directory) !== directory) continue;
      const names = await readdir(directory);
      if (names.length > 1000) throw new Error('Project migration directory bound exceeded');
      for (const name of names.filter(name => /^\d+[^/]*\.sql$/.test(name)).sort()) {
        const sql = await boundedSource(join(directory, name));
        const source = sql && sqlMigrationCensusSource(sql, `app-migrations:registry:${project.slug}:${project.path}:${output}/${name}`);
        if (source) sources.push(source);
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return sources;
}

async function boundedSource(path: string, bound = 1_048_576): Promise<string | null> {
  let handle;
  try {
    if (await realpath(path) !== resolve(path)) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > bound) return null;
    return await handle.readFile('utf8');
  } catch (error) {
    // An installed unit may belong to another user. No readable source means
    // no provenance declaration; the database remains census residue.
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  } finally { await handle?.close(); }
}

/** Only a literal defineConfig export is evidence; never evaluate TS or imports. */
function literalDrizzleOutput(source: string): string | null {
  const file = ts.createSourceFile('drizzle.config.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    const call = statement.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'defineConfig' || call.arguments.length !== 1) continue;
    const config = call.arguments[0];
    if (!ts.isObjectLiteralExpression(config) || config.properties.some(property => !ts.isPropertyAssignment(property))) continue;
    const outputs = config.properties.filter(property => ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'out');
    if (outputs.length !== 1 || !ts.isPropertyAssignment(outputs[0]) || !ts.isStringLiteral(outputs[0].initializer)) return null;
    const output = outputs[0].initializer.text;
    return !isAbsolute(output) && !/[\\%]/.test(output) ? output : null;
  }
  return null;
}

/** A producer's consecutive migration-table prefix establishes retained state.
 * Older schemas stay exportable without claiming the latest migrations applied.
 * This identifies schema provenance, not live application identity or contents.
 */
export interface MigrationCensusColumn {
  table: string;
  name: string;
  type: string;
  udtSchema?: string;
  udtName?: string;
}
export interface MigrationCensusSource {
  producer: string;
  tables: readonly string[];
  columns?: readonly MigrationCensusColumn[];
}

/** SQL literals/comments cannot introduce schema evidence. Unsupported column
 * syntax fails closed; later additive migrations need not erase older provenance.
 */
export function sqlMigrationCensusSource(source: string, producer: string): MigrationCensusSource | null {
  const keywords = stripCommentsAndStrings(source, 'migration.sql');
  const code = stripSqlCommentsAndStrings(source, { preserveIdentifiers: true });
  const identifier = '(?:[a-z_][a-z0-9_]*|"[a-z_][a-z0-9_]*")';
  const normalize = (name: string) => name.startsWith('"') ? name.slice(1, -1) : name.toLowerCase();
  const tables: string[] = [];
  const columns: MigrationCensusColumn[] = [];
  const enumTypes = new Set<string>();
  const enums = new RegExp(`\\bCREATE\\s+TYPE\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?\\s+AS\\s+ENUM\\s*\\([^)]*\\)\\s*;`, 'gi');
  for (const match of code.matchAll(enums)) {
    if (!/^CREATE\s+TYPE\b/i.test(keywords.slice(match.index))) continue;
    enumTypes.add(match[2] ? `${normalize(match[1])}.${normalize(match[2])}` : `public.${normalize(match[1])}`);
  }
  const creates = new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?\\s*\\(`, 'gi');
  for (const match of code.matchAll(creates)) {
    // Preserved identifiers may themselves contain SQL-looking text. Only live
    // keywords in the fully masked stream can introduce schema evidence.
    if (!/^CREATE\s+TABLE\b/i.test(keywords.slice(match.index))) continue;
    const table = match[2] ? `${normalize(match[1])}.${normalize(match[2])}` : `public.${normalize(match[1])}`;
    let depth = 1;
    let start = match.index! + match[0].length;
    const parts: string[] = [];
    let end = start;
    for (; end < code.length && depth; end++) {
      if (code[end] === '(') depth++;
      if (code[end] === ')') depth--;
      if ((code[end] === ',' && depth === 1) || depth === 0) {
        parts.push(code.slice(start, end).trim());
        start = end + 1;
      }
    }
    if (depth) return null;
    const tableColumns: typeof columns = [];
    for (const part of parts) {
      if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part)) continue;
      const column = part.match(new RegExp(`^(${identifier})\\s+(text|integer|bigint|jsonb|boolean|tsvector|timestamptz|timestamp(?:\\s+(?:with|without)\\s+time\\s+zone)?|double\\s+precision)\\b`, 'i'));
      if (!column) {
        const custom = part.match(new RegExp(`^(${identifier})\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?(?=\\s|$)`, 'i'));
        if (!custom) return null;
        const udtSchema = custom[3] ? normalize(custom[2]) : 'public';
        const udtName = normalize(custom[3] ?? custom[2]);
        if (!enumTypes.has(`${udtSchema}.${udtName}`) ||
          !/^(?:$|NOT\b|NULL\b|PRIMARY\b|DEFAULT\b|REFERENCES\b|UNIQUE\b|CHECK\b)/i.test(part.slice(custom[0].length).trim())) return null;
        tableColumns.push({ table, name: normalize(custom[1]), type: 'USER-DEFINED', udtSchema, udtName });
        continue;
      }
      if (!/^(?:$|NOT\b|NULL\b|PRIMARY\b|DEFAULT\b|REFERENCES\b|UNIQUE\b|CHECK\b)/i.test(part.slice(column[0].length).trim())) return null;
      const sqlType = column[2].toLowerCase().replace(/\s+/g, ' ');
      const type = sqlType === 'timestamptz' ? 'timestamp with time zone'
        : sqlType === 'timestamp' ? 'timestamp without time zone' : sqlType;
      tableColumns.push({ table, name: normalize(column[1]), type });
    }
    if (!tableColumns.length) return null;
    tables.push(table);
    columns.push(...tableColumns);
  }
  return tables.length >= 2 ? { producer, tables, columns } : null;
}

export async function canonicalSqlMigrationCensusSources(): Promise<MigrationCensusSource[]> {
  const directory = resolveSqlDir();
  if (!directory) return [];
  const sources: MigrationCensusSource[] = [];
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const source = sqlMigrationCensusSource(await readFile(join(directory, name), 'utf8'), `canonical-sql-migration:${name}`);
    if (source) sources.push(source);
  }
  return sources;
}

export function migrationDatabaseCensusDeclarations(entry: CensusEntry, observedTables: readonly string[], sources: readonly MigrationCensusSource[], observedColumns: readonly MigrationCensusColumn[] = []): CensusDeclaration[] {
  if (entry.kind !== 'database' || !/^postgres-cluster:\d+$/.test(entry.root)) throw new Error('Missing physical migration database identity');
  return sources.flatMap(source => {
    let prefix = 0;
    while (prefix < source.tables.length && observedTables.includes(source.tables[prefix]) &&
      (!source.columns || source.columns.filter(column => column.table === source.tables[prefix]).every(column =>
        observedColumns.some(observed => observed.table === column.table && observed.name === column.name && observed.type === column.type &&
          (!column.udtName || (observed.udtSchema === column.udtSchema && observed.udtName === column.udtName)))))) prefix++;
    return prefix < 2 ? [] : [{ ...entry, classification: 'state' as const,
      producer: prefix === source.tables.length ? source.producer : `${source.producer}:migration-prefix:${prefix}/${source.tables.length}` }];
  });
}
/** Python/uv's environment marker and generated interpreter/package layout.
 * The directory name alone never establishes rebuildable ownership.
 */
export async function virtualenvCacheDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid virtualenv path');
  const path = join(root.path, name);
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid virtualenv directory');
  const handle = await open(join(path, 'pyvenv.cfg'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid virtualenv marker');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const fields = new Map(text.trim().split(/\r?\n/).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
  const version = (fields.get('version') ?? fields.get('version_info'))?.match(/^(\d+\.\d+)\.\d+$/)?.[1];
  const home = fields.get('home');
  if (!version || !home || !(isAbsolute(home) || win32.isAbsolute(home)) ||
    !['true', 'false'].includes(fields.get('include-system-site-packages') ?? '')) throw new Error('Invalid virtualenv marker');
  let windows = false;
  try { await lstat(join(path, 'bin', 'python')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!(await lstat(join(path, 'Scripts', 'python.exe'))).isFile()) throw new Error('Invalid virtualenv interpreter');
    windows = true;
  }
  if (!(await lstat(windows ? join(path, 'Lib', 'site-packages') : join(path, 'lib', `python${version}`, 'site-packages'))).isDirectory()) throw new Error('Invalid virtualenv packages');
  return { kind: 'path', root: root.id, name, classification: 'cache', producer: 'python-virtualenv', descendants: true, prune: true };
}
/** Restore-to-clone completion is producer provenance, not byte certification.
 * A latest started/failed event never authorizes an opaque completed clone.
 */
export async function restoredCloneCensusDeclarations(sql: Sql, workspaceId: string, workspacePath: string, roots: readonly CensusRoot[]): Promise<CensusDeclaration[]> {
  const rows = await sql<{ id: string; target: string; phase: string }[]>`
    SELECT DISTINCT ON (payload_json->>'target') id::text,
      payload_json->>'target' AS target, payload_json->>'phase' AS phase
    FROM harness_shared.backup_events
    WHERE workspace_id = ${workspaceId} AND kind = 'restore'
      AND starts_with(payload_json->>'target', ${join(workspacePath, '.restored') + sep})
    ORDER BY payload_json->>'target', id DESC LIMIT 1001
  `;
  if (rows.length > 1000) throw new Error('Restore event census bound exceeded');
  const declarations: CensusDeclaration[] = [];
  for (const row of rows) {
    if (row.phase !== 'done') continue;
    const clone = relative(join(workspacePath, '.restored'), row.target);
    if (clone.split(sep).length !== 2 || clone.split(sep).some(part => !part || part === '.' || part === '..')) continue;
    const root = roots.find(candidate => {
      const suffix = relative(candidate.path, row.target);
      return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
    });
    if (!root || !/^\d+$/.test(row.id)) throw new Error('Unqualified restore census evidence');
    try { if (!(await lstat(row.target)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push({ kind: 'path', root: root.id, name: relative(root.path, row.target).split(sep).join('/'),
      classification: 'state', producer: 'workspace-backup-restore-to-clone', descendants: true,
      recoveryStorage: { restoreEventId: row.id, evidenceRef: `backup-restore-event:${workspaceId}:${row.id}` } });
  }
  return declarations;
}
/** Published generations are retained install state, including rollback artifacts.
 * Build provenance does not certify the bytes of a running or exported snapshot.
 */
export async function portalReleaseStorageDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid release storage path');
  }
  const path = join(root.path, name);
  if (!(await lstat(path)).isDirectory()) throw new Error('Invalid release storage directory');
  const handle = await open(join(path, '.papercusp-release.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16_384) throw new Error('Invalid release manifest');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const manifest = JSON.parse(text);
  if (![1, 2].includes(manifest.schemaVersion) || manifest.release !== basename(name) ||
    typeof manifest.buildId !== 'string' || !manifest.buildId.trim() ||
    (manifest.schemaVersion === 2 && (typeof manifest.sourceRoot !== 'string' ||
      !(isAbsolute(manifest.sourceRoot) || win32.isAbsolute(manifest.sourceRoot)))) ||
    typeof manifest.publishedAt !== 'string' || !Number.isFinite(Date.parse(manifest.publishedAt))) {
    throw new Error(`Invalid release manifest: ${name}`);
  }
  if (!(await lstat(join(path, 'standalone-entry.mjs'))).isFile()) throw new Error('Missing release entry');
  return { kind: 'path', root: root.id, name, classification: 'state', producer: 'portal-standalone-publish',
    descendants: true, releaseStorage: { manifestSha256: createHash('sha256').update(text).digest('hex'),
      evidenceRef: `portal-release-manifest:${root.id}:${name}` } };
}
/** Read producer evidence without booting Corestore, acquiring its lock, or healing it.
 * The marker hash identifies this observation, not database contents or a portable key.
 */
export async function peerStorageDeclaration(root: CensusRoot, name: string): Promise<CensusDeclaration> {
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid peer storage path');
  }
  const path = join(root.path, name);
  if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, 'db'))).isDirectory()) {
    throw new Error('Invalid peer storage directory');
  }
  const handle = await open(join(path, 'CORESTORE'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let marker: string;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid peer storage marker');
    marker = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const fields = new Map<string, string>();
  for (const line of marker.trim().split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 1 || fields.has(line.slice(0, separator))) throw new Error('Invalid peer storage marker');
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  if (!['linux', 'darwin', 'win32'].includes(fields.get('device/platform') ?? '') ||
    !/^\d+$/.test(fields.get('device/inode') ?? '') || !/^\d+$/.test(fields.get('device/created') ?? '')) {
    throw new Error('Invalid peer storage marker');
  }
  return { kind: 'path', root: root.id, name, classification: 'state', producer: 'corestore-device-file',
    descendants: true, peerStorage: { markerSha256: createHash('sha256').update(marker).digest('hex'),
      evidenceRef: `corestore-marker:${root.id}:${name}` } };
}
/** Preserve metadata only after Git confirms this exact directory owns it. */
export async function gitStorageDeclaration(root: CensusRoot, repositoryName: string, preserveWorktree = false): Promise<CensusDeclaration> {
  if (repositoryName.startsWith('/') || repositoryName.split('/').some(segment => segment === '..')) throw new Error('Invalid repository path');
  const reposit
