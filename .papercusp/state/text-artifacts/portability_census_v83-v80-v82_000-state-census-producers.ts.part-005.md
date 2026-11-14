---
rel_path: "portability/census/v83-v80-v82/000-state-census-producers.ts.part-005"
updated_at: 1794268279628
_body: "content"
---

e = homedir()) {
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

/** Exact installed EnvironmentFile references supply secret-path ownership.
 * Read unit definitions and file metadata only; never open credential files or
 * follow their targets. Unsupported syntax supplies no ownership evidence.
 */
export async function unitEnvironmentFileCensusDeclarations(
  units: readonly CensusDeclaration[], roots: readonly CensusRoot[], home = homedir(),
): Promise<CensusDeclaration[]> {
  const declarations: CensusDeclaration[] = [];
  const seen = new Set<string>();
  for (const unit of units) {
    if (unit.kind !== 'unit' || !['systemd-user', 'systemd-system'].includes(unit.root) ||
      !unit.name.endsWith('.service') || /[/\\]/.test(unit.name) || !unit.producer.startsWith('unit-definition:')) continue;
    const identity = `${unit.root}:${unit.name}`;
    // installedUnitCensusDeclarations preserves systemd load-path precedence.
    // A masked/alias higher-priority definition must not expose a shadow unit.
    if (seen.has(identity)) continue;
    seen.add(identity);
    const directory = unit.producer.slice('unit-definition:'.length);
    if (!isAbsolute(directory)) continue;
    // systemctl link installs a same-name symlink to an external definition.
    // Resolve only that definition, preserving the installed identity; aliases
    // (different target name), masks and redirected source directories provide
    // no evidence. boundedSource opens the canonical regular file with NOFOLLOW.
    let definition = join(directory, unit.name);
    try {
      if (await realpath(directory) !== resolve(directory)) continue;
      definition = await realpath(definition);
      if (basename(definition) !== unit.name) continue;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      throw error;
    }
    const text = await boundedSource(definition, 65_536);
    if (text === null) continue;
    let section = '';
    let continued = false;
    const files: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || /^[#;]/.test(line)) continue;
      const precedingContinuation = continued;
      continued = line.endsWith('\\');
      // Do not reinterpret a continuation fragment as a fresh directive.
      if (precedingContinuation || continued) continue;
      const heading = /^\[([^\]]+)\]$/.exec(line);
      if (heading) { section = heading[1]; continue; }
      const match = section === 'Service' && /^EnvironmentFile\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[1].trim();
      if (/^["']/.test(value)) {
        const quote = value[0];
        if (value.length < 2 || !value.endsWith(quote) || value.slice(1, -1).includes(quote)) continue;
        value = value.slice(1, -1);
      } else if (/\s|["']/.test(value)) continue;
      // systemd's empty assignment discards every earlier file reference.
      if (!value) { files.length = 0; continue; }
      value = value.replace(/^-/, '');
      if (!isAbsolute(value) && !value.startsWith('%h/')) continue;
      if (/[\\\x00-\x1f*?\[\]]/.test(value) || value.split('/').includes('..')) continue;
      let unsupported = false;
      value = value.replace(/%([\s\S])|%$/g, (_token, specifier: string | undefined) => {
        if (specifier === '%') return '%';
        // %h belongs to the service manager, not the service's User= setting.
        if (specifier === 'h' && unit.root === 'systemd-user') return home;
        unsupported = true;
        return '';
      });
      if (!unsupported && isAbsolute(value)) files.push(value);
    }
    for (const file of new Set(files)) {
      const root = [...roots].sort((a, b) => b.path.length - a.path.length).find(root => {
        const name = relative(root.path, file);
        return name && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
      });
      if (!root) continue;
      try {
        // O_NOFOLLOW on the leaf alone would still traverse linked parents.
        if (await realpath(dirname(file)) !== dirname(file)) continue;
        const stat = await lstat(file);
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      declarations.push({ kind: 'path', root: root.id, name: relative(root.path, file),
        classification: 'secret', producer: `unit-environment-file:${identity}` });
    }
  }
  return declarations;
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
  try { root = (await execFileAsync('git', ['-C', repository, 'rev-parse', '--sho
