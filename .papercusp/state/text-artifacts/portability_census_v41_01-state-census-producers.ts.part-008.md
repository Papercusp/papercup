---
rel_path: "portability/census/v41/01-state-census-producers.ts.part-008"
updated_at: 1794241756285
_body: "content"
---

on[] {
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
   
