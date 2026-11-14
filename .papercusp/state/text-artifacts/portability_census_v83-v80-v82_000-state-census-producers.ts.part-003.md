---
rel_path: "portability/census/v83-v80-v82/000-state-census-producers.ts.part-003"
updated_at: 1794268279628
_body: "content"
---

 'cochange-index') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && /^[0-9a-f]{16}\.json(?:\.[0-9]+\.tmp)?$/.test(entry.name)) {
            declarations.push({ kind: 'path', root: cacheRoot.id, name: `cache/${name}/${entry.name}`,
              classification: 'cache', producer });
          }
        }
      }
    }
  }
  // Mutex leases are host-local process metadata, recreated by the primitive.
  // Transporting them would copy stale ownership onto a different machine.
  // Resolve the writer's real root (including relocation), never inspect or
  // delete a live lease merely to establish this export classification.
  const mutex = resolveFsMutexLockRoot(process.env, { homeDir: home });
  let mutexExists = false;
  try { mutexExists = (await lstat(mutex)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (mutexExists) {
    let parent = roots.find(entry => entry.path === dirname(mutex));
    if (!parent) { parent = { id: 'runtime-mutex-parent', path: dirname(mutex) }; roots.push(parent); }
    declarations.push({ kind: 'path', root: parent.id, name: basename(mutex), classification: 'cache',
      producer: 'filesystem-mutex-runtime', descendants: true, prune: true });
  }
  return { roots, declarations };
}

export function mergeNestedCensusRoots(input: { roots: CensusRoot[]; declarations: CensusDeclaration[] }) {
  const normalized = input.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const contains = (parent: CensusRoot, child: CensusRoot) => {
    const suffix = relative(parent.path, child.path);
    return !suffix || (parent.fileNames === undefined &&
      !suffix.startsWith(`..${sep}`) && suffix !== '..' && !suffix.startsWith(sep));
  };
  const roots = normalized.filter((root, index) => !normalized.some((other, otherIndex) =>
    otherIndex !== index && contains(other, root) && (other.path !== root.path ||
      (other.fileNames === undefined && root.fileNames !== undefined) ||
      ((other.fileNames === undefined) === (root.fileNames === undefined) && otherIndex < index))));
  for (const root of roots) {
    if (root.fileNames !== undefined) root.fileNames = [...new Set(normalized
      .filter(other => other.path === root.path).flatMap(other => other.fileNames ?? []))].sort();
  }
  const declarations = input.declarations.map(declaration => {
    const source = normalized.find(root => root.id === declaration.root);
    if (!source) throw new Error('Census declaration has no root');
    const parent = roots.find(root => contains(root, source));
    if (!parent) throw new Error('Census root merge failed');
    const prefix = relative(parent.path, source.path).split(sep).join('/');
    return { ...declaration, root: parent.id, name: prefix ? `${prefix}/${declaration.name}` : declaration.name };
  });
  return { roots, declarations };
}

/** Result spills are rebuildable, using the actual relocated scratch writer root. */
export function scratchCensusProducer() {
  const path = scratchRoot();
  const root: CensusRoot = { id: 'scratch-parent', path: dirname(path) };
  const declaration: CensusDeclaration = {
    kind: 'path', root: root.id, name: basename(path), classification: 'cache',
    producer: 'scratch-uri', descendants: true, prune: true,
  };
  return { roots: [root], declarations: [declaration] };
}

/** Same relocated compile-analysis cache used by strip-comments-and-strings. */
export function stripRangeCacheCensusProducer(home = homedir()) {
  const path = process.env.PAPERCUSP_STRIP_CACHE_DIR || join(home, '.papercusp', 'cache', 'strip-ranges');
  return { roots: [{ id: 'strip-range-cache-parent', path: dirname(path) }], declarations: [{
    kind: 'path' as const, root: 'strip-range-cache-parent', name: basename(path),
    classification: 'cache' as const, producer: 'strip-comments-and-strings', descendants: true, prune: true,
  }] };
}

/** Exact affected-test writer files; unrelated cache contents remain residue. */
export async function affectedTestCacheCensusProducer(home = homedir()) {
  const directory = join(home, '.papercusp', 'cache');
  const paths = [{ path: process.env.AFFECTED_TASK_HISTORY_PATH ?? join(directory, 'papercusp-affected-task-durations-v1.json'), producer: 'affected-tests-duration-history' }];
  if (process.env.AFFECTED_TASK_VERDICT_CACHE_PATH) {
    paths.push({ path: process.env.AFFECTED_TASK_VERDICT_CACHE_PATH, producer: 'affected-tests-passing-verdict' });
    paths.push({ path: closureDigestManifestPath(process.env.AFFECTED_TASK_VERDICT_CACHE_PATH), producer: 'affected-tests-closure-manifest' });
  }
  const closureSuffix = closureDigestManifestPath('');
  const verdictName = /^papercusp-affected-passing-verdicts-v2-(?:committed-)?[0-9a-f]{16}\.json$/;
  const partialName = new RegExp(`^papercusp-affected-partial-v${PARTIAL_TASK_CHECKPOINT_SCHEMA}-[0-9a-f]{24}\\.json$`);
  const partialDirectory = process.env.AFFECTED_PARTIAL_RESUME_CACHE_DIR || directory;
  for (const cacheDirectory of new Set([directory, partialDirectory].map(path => resolve(path)))) {
    // A relocated writer directory is not authority to follow a symlink or own
    // all of its contents. Enumerate only exact regular writer files.
    try { if (!(await lstat(cacheDirectory)).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const closure = entry.name.endsWith(closureSuffix);
      const verdict = closure ? entry.name.slice(0, -closureSuffix.length) : entry.name;
      if (cacheDirectory === resolve(directory) && verdictName.test(verdict)) {
        paths.push({ path: join(cacheDirectory, entry.name),
          producer: closure ? 'affected-tests-closure-manifest' : 'affected-tests-passing-verdict' });
      } else if (partialName.test(entry.name)) {
        paths.push({ path: join(cacheDirectory, entry.name), producer: 'affected-tests-partial-checkpoint' });
      }
    }
  }
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const path = resolve(entry.path);
    if (seen.has(path)) continue;
    seen.add(path);
    try { if (!(await lstat(entry.path)).isFile()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const directory = dirname(resolve(entry.path));
    let root = roots.find(root => root.path === directory);
    if (!root) { root = { id: `affected-test-cache-${roots.length}`, path: directory }; roots.push(root); }
    declarations.push({ kind: 'path', root: root.id, name: basename(entry.path), classification: 'cache', producer: entry.producer });
  }
  return { roots, declarations };
}

/** Registry producer's real relocated root, not the operator's remapped HOME. */
export function workspaceRegistryCensusProducer() {
  const root: CensusRoot = { id: 'workspace-registry', path: workspacesRoot() };
  const declaration: CensusDeclaration = {
    kind: 'path', root: root.id, name: 'registry.json',
    classification: 'config', producer: 'workspace-registry',
  };
  // The registry is the producer authority for directory names. Classify only
  // directory entries here: their contents still require their own producers.
  const workspaceDirectories: CensusDeclaration[] = readRegistry().workspaces.map(workspace => ({
    kind: 'path', root: root.id, name: workspace.id,
    classification: 'state', producer: 'workspace-registry',
  }));
  return { roots: [root], declarations: [declaration, ...workspaceDirectories] };
}

/** Derive secret locations from their writers, including relocated mounted keys. */
export function secretCensusProducers() {
  const paths = [
    { path: dbEncryptionKeyFilePath(), producer: 'db-encryption' },
    { path: superuserTokenPath(), producer: 'superuser-token' },
    { path: googleOAuthClientPath(), producer: 'google-oauth-desktop-client' },
    { path: oauthStateKeyFilePath(), producer: 'oauth-state-signing-key' },
    { path: fleetClaudeTokenPath(), producer: 'fleet-claude-token' },
  ];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const { path, producer } of paths) {
    const directory = dirname(path);
    let root = roots.find(candidate => candidate.path === directory);
    if (!root) {
      root = { id: `secret-directory-${roots.length}`, path: directory };
      roots.push(root);
    }
    declarations.push({ kind: 'path', root: root.id, name: basename(path),
      classification: 'secret', producer });
  }
  return { roots, declarations };
}

/** Exact paths resolved by deploy, download publishers and VM admin commands. */
export function hostedConfigurationCensusProducers(home = homedir()) {
  const config = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const paths = [
    { path: process.env.PAPERCUSP_HOSTED_CP_ENV_FILE || join(config, 'papercusp', 'hosted-control-plane.env'), classification: 'secret' as const, producer: 'deploy-hosted-control-plane' },
    { path: process.env.PAPERCUSP_CLOUD_PORTAL_HOSTED_ENV_FILE || join(config, 'papercusp', 'hosted-control-plane.env'), classification: 'secret' as const, producer: 'deploy-cloud-portal' },
    { path: process.env.PUI_PORTAL_LINKS_ENV || join(home, '.config', 'papercusp', 'portal-public-links.env'), classification: 'config' as const, producer: 'publish-tui-release' },
    { path: join(home, BUILD_VM_ENV_HOME_RELATIVE_PATH), classification: 'secret' as const, producer: 'admin-build-vm-config' },
  ];
  const roots: CensusRoot[] = [];
  const declarations: CensusDeclaration[] = [];
  for (const entry of paths) {
    let root = roots.find(candidate => candidate.path === dirname(entry.path));
    if (!root) { root = { id: `hosted-config-${roots.length}`, path: dirname(entry.path) }; roots.push(root); }
    declarations.push({ kind: 'path', root: root.id, name: basename(entry.path), classification: entry.classification, producer: entry.producer });
  }
  return { roots, declarations };
}

/** One measured historical writer dialect. Whole-program matching prevents a
 * later overwrite, reassignment or unrelated call from masquerading as proof.
 * Only the three AST-derived path/URL literals may vary; nothing is evaluated.
 */
const hostedProfileWriter = `import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createCipheriv,scryptSync,randomBytes} from 'node:crypto';
import {hostname,userInfo} from 'node:os';
import {runInNewContext} from 'node:vm';
const fixture=resolve(userInfo().homedir,'FIXTURE');
const destination=resolve(userInfo().homedir,'DESTINATION');
if(existsSync(destination)) throw new Error('Destination exists: inspect before overwrite');
if((statSync(fixture).mode&0o777)!==0o600) throw new Error('Fixture must remain private');
const source=readFileSync('node_modules/verdict-cli/src/server.mjs','utf8');
const start=source.indexOf('const MACHINE_KEY =');
const end=source.indexOf('function decryptData',start);
const encrypt=runInNewContext(source.slice(start,end)+'\\nencryptData;', {hostname,userInfo,scryptSync,randomBytes,createCipheriv,Buffer});
const state=JSON.parse(readFileSync(fixture,'utf8'));
writeFileSync(destination,encrypt({cookies:state.cookies,storage:{localStorage:{},sessionStorage:{}},url:'URL',savedAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({profile:destination,mode:'0600',cookieCount:state.cookies.length,expirationPreserved:true,valuesPrinted:false}));`;

function sourceTokens(source: string, replacements = new Map<string, string>()) {
  const parsed = ts.createSourceFile('evidence.js', source, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(parsed, [context => node => {
    const visit: ts.Visitor = child => ts.isStringLiteral(child)
      ? ts.factory.createStringLiteral(replacements.get(child.text) ?? child.text)
      : ts.visitEachChild(child, visit, context);
    return ts.visitNode(node, visit) as ts.SourceFile;
  }]);
  const normalized = ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
  transformed.dispose();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, normalized);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const value = token === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText();
    tokens.push(JSON.stringify([token, value]));
  }
  return tokens.join('|');
}

export function historicalHostedProfileConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(outer) === 'tools.exec_command' &&
      node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(outer) === 'cmd' && ts.isStringLiteralLike(property.initializer)) commands.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  // A native exec input can batch the writer with a subsequent browser snapshot.
  // Select the supported quoted program, not the last cmd property in the AST.
  const candidates = commands.map(command => command.match(/^node --input-type=module <<'JS'\n([\s\S]*)\nJS$/)).filter(match => match !== null);
  if (candidates.length !== 1) return null;
  const match = candidates[0];
  const program = ts.createSourceFile('writer.js', match[1], ts.ScriptTarget.Latest, true);
  const literals = new Map<string, string>();
  for (const statement of program.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['fixture', 'destination'].includes(declaration.name.text) ||
        !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const value = declaration.initializer.arguments[1];
      if (value && ts.isStringLiteralLike(value)) literals.set(declaration.name.text, value.text);
    }
  }
  let url: string | undefined;
  const findUrl = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(program) === 'url' && ts.isStringLiteralLike(node.initializer)) url = node.initializer.text;
    ts.forEachChild(node, findUrl);
  };
  findUrl(program);
  const fixture = literals.get('fixture');
  const destination = literals.get('destination');
  if (!fixture || !destination || !url || new Set([fixture, destination, url]).size !== 3) return null;
  if (commands.some(command => !command.match(/^node --input-type=module <<'JS'\n([\s\S]*)\nJS$/) &&
    (command.includes(fixture) || command.includes(destination)))) return null;
  const replacements = new Map([[fixture, 'FIXTURE'], [destination, 'DESTINATION'], [url, 'URL']]);
  if (sourceTokens(match[1], replacements) !== sourceTokens(hostedProfileWriter)) return null;
  // Historical evidence grants inspection of exact Papercusp configuration files,
  // not arbitrary paths mentioned in a transcript or linked destinations.
  const config = join(home, '.config', 'papercusp');
  const input = resolve(home, fixture);
  const output = resolve(home, destination);
  if (dirname(input) !== config || dirname(output) !== config || input === output) return null;
  return { input, output, url };
}

export interface HostedProfileWriterEvidence { ref: string; toolInput: string; startedAt: string; finishedAt: string }

// Archived call_dQMd66bJTVYVPiteJs6wlHg9, 2026-09-05. Only path literals vary.
// This program is evidence to parse, never a command to execute.
const playwrightStateWriter = String.raw`const { chromium }=require('./node_modules/@playwright/test');
const fs=require('fs');
const identity=JSON.parse(fs.readFileSync('IDENTITY','utf8'));
const password=fs.readFileSync('PASSWORD','utf8').trim();
const statePath='DESTINATION';
(async()=>{
  const browser=await chromium.launch({headless:true,proxy:{server:'socks5://127.0.0.1:18029'}});
  const c=await browser.newContext({serviceWorkers:'block'});const p=await c.newPage();
  await p.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces',{waitUntil:'domcontentloaded',timeout:60000});
  for(let i=0;i<3;i++){
    const pw=p.locator('input[type=password],input[name=password]').first();if(await pw.isVisible().catch(()=>false))break;
    const em=p.locator('input[name=email],input[type=email]').first();await em.waitFor({state:'visible',timeout:30000});await em.fill(identity.email);
    await p.getByRole('button',{name:/continue with email|continue|sign in/i}).first().click();await p.waitForTimeout(2500);
  }
  const pw=p.locator('input[type=password],input[name=password]').first();await pw.waitFor({state:'visible',timeout:30000});await pw.fill(password);
  await p.getByRole('button',{name:/sign in|continue/i}).first().click();
  await p.waitForURL(u=>u.hostname==='app.papercusp.com'&&u.pathname!=='/api/hosted/auth/callback',{timeout:60000,waitUntil:'domcontentloaded'});
  const session=await p.evaluate(async()=>{const r=await fetch('/api/hosted/auth/session',{cache:'no-store'});const b=await r.json().catch(()=>null);return{status:r.status,ok:b?.ok===true,session:b?.session?{workspaceId:b.session.workspaceId??null,organizationId:b.session.organizationId??null,expiresAtMs:b.session.expiresAtMs??null,sessionVersion:b.session.sessionVersion??null}:null,error:b?.error??null}});
  await c.storageState({path:statePath});fs.chmodSync(statePath,0o600);const st=fs.statSync(statePath);
  console.log(JSON.stringify({final:{host:new URL(p.url()).host,path:new URL(p.url()).pathname},session,storageState:{path:statePath,mode:(st.mode&0o777).toString(8),bytes:st.size}},null,2));
  await browser.close();
})().catch(e=>{console.error(JSON.stringify({error:String(e),name:e?.name||null}));process.exit(1)});`;

// Exact inner program from SHA-verified codex archive 01a07742, line 614.
// Authentication metadata is a receipt, not a digest of the complete saved file.
const playwrightStateWriterSept6 = "const { chromium } = require('./node_modules/@playwright/test');\nconst fs = require('fs');\nconst crypto = require('crypto');\nconst identity = JSON.parse(fs.readFileSync('IDENTITY', 'utf8'));\nconst password = fs.readFileSync('PASSWORD', 'utf8').trim();\nconst statePath = 'DESTINATION';\n(async () => {\n  const startedAt = Date.now();\n  const browser = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:18029' } });\n  try {\n    const context = await browser.newContext({ serviceWorkers: 'block' });\n    const page = await context.newPage();\n    await page.goto('https://app.papercusp.com/api/hosted/auth/sign-in?returnTo=%2Fcloud-workspaces', { waitUntil: 'domcontentloaded', timeout: 60000 });\n    const editableEmail = page.locator('input[name=email]:not([readonly]),input[type=email]:not([readonly])').first();\n    const passwordInput = page.locator('input[type=password],input[name=password]').first();\n    await Promise.race([editableEmail.waitFor({ state: 'visible', timeout: 30000 }), passwordInput.waitFor({ state: 'visible', timeout: 30000 })]);\n    if (await editableEmail.isVisible().catch(() => false)) {\n      await editableEmail.fill(identity.email);\n      await page.getByRole('button', { name: /continue with email|continue|sign in/i }).first().click();\n    }\n    await passwordInput.waitFor({ state: 'visible', timeout: 30000 });\n    await passwordInput.fill(password);\n    await page.getByRole('button', { name: /sign in|continue/i }).first().click();\n    await page.waitForURL((url) => url.hostname === 'app.papercusp.com', { timeout: 60000 });\n    let session = null;\n    for (let attempt = 0; attempt < 30; attempt += 1) {\n      const response = await context.request.get('https://app.papercusp.com/api/hosted/auth/session', { failOnStatusCode: false });\n      const body = await response.json().catch(() => null);\n      if (response.status() === 200 && body?.ok === true && body?.session?.sessionId && body?.session?.userId && body?.session?.organizationId) {\n        session = body.session;\n        break;\n      }\n      await page.waitForTimeout(1000);\n    }\n    if (!session) throw new Error('authenticated session metadata did not become available');\n    await context.storageState({ path: statePath });\n    fs.chmodSync(statePath, 0o600);\n    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));\n    const appCookie = saved.cookies.find((cookie) => cookie.name === '__Host-papercusp_session');\n    console.log(JSON.stringify({\n      ok: true,\n      statePath,\n      mode: (fs.statSync(statePath).mode & 0o777).toString(8),\n      sessionHash: crypto.createHash('sha256').update(session.sessionId).digest('hex').slice(0, 12),\n      userPresent: Boolean(session.userId),\n      organizationPresent: Boolean(session.organizationId),\n      workspaceBound: Boolean(session.workspaceId),\n      cookiePresent: Boolean(appCookie),\n      cookieExpires: appCookie?.expires ?? null,\n      durationMs: Date.now() - startedAt,\n    }));\n  } finally {\n    await browser.close();\n  }\n})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });";

export function historicalPlaywrightStateConstruction(toolInput: string, home = homedir()) {
  if (toolInput.length > 65_536) return null;
  const outer = ts.createSourceFile('tool.js', toolInput, ts.ScriptTarget.Latest, true);
  const commands: string[] = [];
  // September 6 uses a top-level const and prints the terminal envelope. Resolve
  // that binding only for the complete measured wrapper, never arbitrary JS.
  const commandDeclaration = outer.statements[0];
  if (commandDeclaration && ts.isVariableStatement(commandDeclaration) &&
    (commandDeclaration.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    commandDeclaration.declarationList.declarations.length === 1) {
    const declaration = commandDeclaration.declarationList.declarations[0];
    if (ts.isIdentifier(declaration.name) && declaration.name.text === 'cmd' &&
      declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
      const wrapper = `const cmd = 'COMMAND';
let r=await tools.exec_command({cmd,workdir:'WORKDIR',yield_time_ms:30000,max_output_tokens:3000});
while('session_id'in r&&!Object.prototype.hasOwnProperty.call(r,'exit_code'))r=await tools.write_stdin({session_id:r.session_id,chars:'',yield_time_ms:30000,max_output_tokens:3000});
text(r);`;
      if (sourceTokens(toolInput, new Map([[declaration.initializer.text, 'COMMAND'],
        [join(home, 'papercupai-workspace', 'papercusp'), 'WORKDIR']])) !== sourceTokens(wrapper)) return null;
      commands.push(declaration.initializer.text);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(outer) === 'tools.exec_command' &&
      node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const property of node.arguments[0].properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText(outer) === 'cmd' && ts.isStringLiteralLike(property.initializer)) commands.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(outer);
  if (commands.length !== 1) return null;
  const match = comm
