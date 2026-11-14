---
rel_path: "portability/census/v41/01-state-census-producers.ts.part-005"
updated_at: 1794241756285
_body: "content"
---

lizer)) commands.push(property.initializer.text);
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
  const match = commands[0].match(/^node - <<'NODE'\n([\s\S]*)\nNODE$/);
  if (!match) return null;
  const program = ts.createSourceFile('writer.js', match[1], ts.ScriptTarget.Latest, true);
  const paths = new Map<string, string>();
  const findPaths = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (node.name.text === 'statePath' && ts.isStringLiteral(node.initializer)) paths.set('DESTINATION', node.initializer.text);
      if (['identity', 'password'].includes(node.name.text)) {
        const literals: string[] = [];
        const findRead = (child: ts.Node) => {
          if (ts.isCallExpression(child) && child.expression.getText(program) === 'fs.readFileSync' &&
            child.arguments[0] && ts.isStringLiteral(child.arguments[0])) literals.push(child.arguments[0].text);
          ts.forEachChild(child, findRead);
        };
        findRead(node.initializer);
        if (literals.length === 1) paths.set(node.name.text.toUpperCase(), literals[0]);
      }
    }
    ts.forEachChild(node, findPaths);
  };
  findPaths(program);
  const output = paths.get('DESTINATION'); const identity = paths.get('IDENTITY'); const password = paths.get('PASSWORD');
  if (!output || !identity || !password || new Set(paths.values()).size !== 3 ||
    dirname(output) !== join(home, '.config', 'papercusp') ||
    !/^\/run\/user\/\d+\//.test(identity) || dirname(identity) !== dirname(password)) return null;
  const normalized = sourceTokens(match[1], new Map([...paths].map(([key, value]) => [value, key])));
  if (![playwrightStateWriter, playwrightStateWriterSept6].some(writer => normalized === sourceTokens(writer))) return null;
  return { output };
}

export interface PlaywrightStateWriterEvidence extends HostedProfileWriterEvidence { receipt: string; indexedRef?: string }

export interface IndexedCensusWriterEvidence extends HostedProfileWriterEvidence { sessionId: string }

/** Locate writers independently of receipt layout. An adjacent result is only
 * the legacy fallback timestamp; canonical archive recovery pairs by call_id.
 */
export async function readHistoricalCensusWriterCandidates(sql: Sql) {
  const candidates = await sql<IndexedCensusWriterEvidence[]>`
    SELECT 'session-part:' || writer.source_kind || ':' || writer.session_id || ':' || writer.part_idx AS ref,
      writer.session_id AS "sessionId", writer.text AS "toolInput", writer.ts::text AS "startedAt",
      COALESCE(receipt.ts::text, '') AS "finishedAt"
    FROM harness_shared.session_turn_parts writer
    LEFT JOIN harness_shared.session_turn_parts receipt
      ON receipt.workspace_id = writer.workspace_id AND receipt.source_kind = writer.source_kind
      AND receipt.session_id = writer.session_id AND receipt.part_idx = writer.part_idx + 1
      AND receipt.part_kind = 'tool_result'
    WHERE writer.workspace_id = 'default' AND writer.source_kind = 'codex' AND writer.part_kind = 'tool_use'
      AND (writer.text LIKE '%writeFileSync(destination,encrypt(%'
        OR (writer.text LIKE '%chromium%' AND writer.text LIKE '%statePath%')
        OR writer.text LIKE '%securewrite(%')
    ORDER BY writer.session_id, writer.part_idx
    LIMIT 101
  `;
  if (candidates.length > 100) throw new Error('Historical census evidence bound exceeded');
  return candidates;
}

/** Attest the complete measured Python dialect without executing archived code.
 * Only its three private path literals vary. The hash covers securewrite, test
 * a
