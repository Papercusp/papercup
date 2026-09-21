#!/usr/bin/env node

/**
 * P-015 R-4: isolated, pointer-driven identity review journey.
 *
 * This driver owns a disposable coord_presence/adv_sessions fixture in the
 * verifier's isolated database, then drives the real Tauri webview. Mutation
 * responses are deliberately synthetic: this proves the UI's review,
 * failure, retry, and rollback rendering without pretending to prove a real
 * host activation. The artifact records that boundary explicitly.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";

/**
 * @param {string|number} pid
 * @param {readonly string[]} args
 * @returns {string[]}
 */
export function toolArgs(pid, args) {
  return [args[0], "--pid", pid, ...args.slice(1), ...(args[0] === "eval" ? [] : ["--json"])];
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {Record<string, any>} [options]
 * @returns {string}
 */
export function checkedCommand(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", timeout: 45_000, ...options });
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name} (run through verify-tauri-headless.sh)`);
  return value;
};

export async function main() {
const pid = required("VERIFY_TAURI_PID");
const dsn = required("HARNESS_ADMIN_DATABASE_URL");
if (process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== "1") {
  throw new Error("PAPERCUSP_VERIFY_TAURI_ISOLATED=1 required; refusing shared database");
}
const isolatedHome = required("PAPERCUSP_HOME");
const parsedDsn = new URL(dsn);
if (!["127.0.0.1", "localhost"].includes(parsedDsn.hostname)
    || parsedDsn.port !== required("PAPERCUSP_PG_PORT")) {
  throw new Error("database address does not match the isolated verifier port");
}
required("VERIFY_TAURI_OWNER_SID");
required("VERIFY_TAURI_LAUNCH_PROVENANCE");
required("VERIFY_TAURI_SPA_DIST");
if (process.argv.includes("--preflight")) process.exit(0);
const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN || "tauri-agent-tools";
const workspace = process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE || "default";
const realBackend = process.env.P015_R4_REAL_BACKEND === "1";
const owner = `p015-r4-owned-${process.pid}-${Date.now()}`;
const label = `P-015 R-4 disposable owner ${owner.slice(-12)}`;
const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
const outDir = process.env.TAURI_SURFACE_VERIFY_P015_R4_OUT || `/tmp/p015-r4-identities-${stamp}`;
mkdirSync(outDir, { recursive: true });

const evidence = {
  schemaVersion: "p015-r4-identities-ui-v1",
  status: "running",
  realBackend,
  syntheticMutationResponses: !realBackend,
  hostActivationProven: false,
  workspace,
  owner,
  ownerLabel: label,
  treeHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  bridgePid: Number(pid),
  bridgeOwnerSid: process.env.VERIFY_TAURI_OWNER_SID || null,
  launchProvenance: process.env.VERIFY_TAURI_LAUNCH_PROVENANCE || null,
  frozenSpaDist: process.env.VERIFY_TAURI_SPA_DIST || null,
  steps: [],
};

const sql = postgres(dsn, { max: 1, connect_timeout: 10, idle_timeout: 2, onnotice: () => {} });
let sessionId = null;
let isolationVerified = false;

const run = (args, label) => {
  const result = checkedCommand(tool, toolArgs(pid, args), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  });
  evidence.steps.push({ label, command: [tool, "--pid", pid, ...args].join(" "), result: result.trim() });
  return result;
};

const settle = () => {
  const settlePath = process.env.VERIFY_TAURI_SETTLE;
  if (!settlePath) throw new Error("VERIFY_TAURI_SETTLE is required");
  execFileSync("bash", [settlePath], { stdio: "inherit", timeout: 45_000 });
};

const check = (args, label) => {
  try {
    // A sync invalidation may finish after DOM quiet; poll the actual predicate,
    // then record the exit-coded check against the settled page.
    const pollArgs = args.includes("--eval") && !args.includes("--require")
      ? ["--require", "body", ...args]
      : args;
    checkedCommand("bash", [required("VERIFY_TAURI_POLL"), ...pollArgs]);
    run(["check", ...args], label);
  } catch (error) {
    throw new Error(`${label} failed: ${error?.stderr || error?.message || error}`);
  }
};

const click = (selector, label) => {
  const display = required("VERIFY_TAURI_DISPLAY");
  if (!/^:[0-9]+$/.test(display) || Number(display.slice(1)) < 90) {
    throw new Error("pointer input requires a verifier-owned isolated display");
  }
  checkedCommand("bash", [required("VERIFY_TAURI_LIVENESS_CHECK")]);
  const rect = JSON.parse(evalFile(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e || e.disabled) throw new Error('missing or disabled pointer target');
    e.scrollIntoView({block:'center', inline:'center'});
    let r = e.getBoundingClientRect();
    if (r.left < 0 || r.right > window.innerWidth) {
      let node = e.parentElement;
      while (node) {
        if (node.scrollWidth > node.clientWidth) {
          node.scrollLeft += r.left - (window.innerWidth - r.width) / 2;
          r = e.getBoundingClientRect();
        }
        node = node.parentElement;
      }
      const scroller = document.scrollingElement;
      if (scroller) scroller.scrollLeft += r.left - (window.innerWidth - r.width) / 2;
      r = e.getBoundingClientRect();
    }
    if (r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight) {
      throw new Error('pointer target outside viewport: ' + JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:window.innerWidth,height:window.innerHeight}));
    }
    return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2), viewport:{width:window.innerWidth,height:window.innerHeight}};
  })()`, `pointer-${label}`));
  const env = { ...process.env, DISPLAY: display };
  const windows = checkedCommand("xdotool", ["search", "--pid", pid], { env }).trim().split(/\s+/);
  const window = windows.at(-1);
  const geometry = checkedCommand("xwininfo", ["-id", window], { env });
  const x = Number(/Absolute upper-left X:\s*(-?\d+)/.exec(geometry)?.[1]);
  const y = Number(/Absolute upper-left Y:\s*(-?\d+)/.exec(geometry)?.[1]);
  if (![x,y,rect.x,rect.y].every(Number.isFinite)) throw new Error("invalid X11 client origin");
  checkedCommand("xdotool", ["mousemove", "--sync", String(x+rect.x), String(y+rect.y)], { env });
  checkedCommand("xdotool", ["click", "1"], { env });
  evidence.steps.push({ label, input: "X11 pointer", selector, window, display, client: rect });
};

const evalFile = (source, name) => {
  const file = resolve(outDir, `${name}.js`);
  writeFileSync(file, source);
  return run(["eval", "--file", file], `eval:${name}`);
};

const observeActivation = async (label) => {
  const [row] = await sql`
    SELECT control_generation, control_delivered_generation,
           control_state->'activation' AS activation
      FROM harness_shared.session_briefs
     WHERE workspace_id = ${workspace} AND owner_id = ${owner}
  `;
  const activation = row?.activation ?? null;
  evidence.steps.push({
    label,
    controlGeneration: row ? Number(row.control_generation) : null,
    controlDeliveredGeneration: row ? Number(row.control_delivered_generation) : null,
    activation,
  });
  return activation;
};

const acknowledgeRealHost = async (label) => {
  const responseText = evalFile(`
    fetch('/api/agent-mcp/turn-start-memory', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        owner: ${JSON.stringify(owner)},
        workspace: ${JSON.stringify(workspace)},
        prompt: 'identity activation acknowledgement',
        client: 'codex',
      }),
    }).then(async (response) => JSON.stringify({status: response.status, body: await response.text()}))
  `, label);
  let response;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new Error(`${label} returned non-JSON response: ${responseText}`);
  }
  evidence.steps.push({ label, response });
  if (response.status !== 200) throw new Error(`${label} failed: ${responseText}`);
  return response;
};

const captureRealFetch = `
(() => {
  window.__p015R4RealCalls = [];
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const response = await original(input, init);
    if (String(input).includes('/api/agent-mcp/identity-management')) {
      const body = await response.clone().text();
      window.__p015R4RealCalls.push({
        request: JSON.parse(init?.body || '{}'),
        status: response.status,
        body,
      });
    }
    return response;
  };
  return 'p015-r4-real-fetch-observer';
})()
`;

const patchFetch = `
(() => {
  window.__p015R4Calls = [];
  window.__p015R4OriginalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('/api/agent-mcp/identity-management') || init?.method !== 'POST') {
      return window.__p015R4OriginalFetch(input, init);
    }
    const args = JSON.parse(init.body || '{}');
    if (args.ownerId !== ${JSON.stringify(owner)}) throw new Error('unexpected mutation owner');
    window.__p015R4Calls.push(args);
    if (args.action === 'switch' && window.__p015R4Calls.filter(x => x.action === 'switch').length === 1) {
      return new Response(JSON.stringify({ok:false,error:'synthetic R-4 failure; prior applied identity retained'}), {status:503,headers:{'content-type':'application/json'}});
    }
    const revision = { specificationRevision: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', stateRevision: 'synthetic-r4-state' };
    let body;
    if (args.action === 'preview') {
      body = { ok: true, changed: true, action: 'preview', delivery: 'relaunch-with-carry', stack: ['domain:research-steward'], replaced: 'domain:papercusp-engineer', ...revision, diff: [{ field: 'configuration.roles[0]', applied: 'domain:papercusp-engineer', selected: 'research-steward', origin: 'synthetic-r4-verification' }], activation: { desired: revision, prepared: revision, applied: { specificationRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 'seed-old-state' }, status: 'prepared' }, nudge: { queued: false, reason: 'synthetic-r4-verification' } };
    } else if (args.action === 'switch') {
      body = { ok: true, changed: true, action: 'switch', delivery: 'relaunch-with-carry', stack: ['domain:research-steward'], replaced: 'papercusp-engineer', ...revision, diff: [], activation: { desired: revision, prepared: null, applied: { specificationRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 'seed-old-state' }, status: 'failed', failure: 'synthetic R-4 failed activation; prior applied identity retained' }, nudge: { queued: false, reason: 'synthetic-r4-verification' } };
    } else if (args.action === 'rollback') {
      const restored = { specificationRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stateRevision: 'seed-old-state' };
      body = { ok: true, changed: true, action: 'rollback', delivery: 'relaunch-with-carry', stack: ['domain:papercusp-engineer'], replaced: 'research-steward', ...restored, diff: [], activation: { desired: restored, prepared: null, applied: restored, status: 'applied' }, nudge: { queued: false, reason: 'synthetic-r4-verification' } };
    } else {
      throw new Error('unexpected mutation action ' + args.action);
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return 'p015-r4-fetch-patched';
})()
`;

const artifact = (revision) => ({
  schemaVersion: 1,
  specificationRevision: revision,
  compilerVersion: "p015-r4-fixture",
  source: { id: "p015-r4-fixture", kind: "harness", contentHash: "d".repeat(64) },
  configuration: { roles: [{ stack: ["domain:papercusp-engineer"] }] },
  inputs: [],
  stack: ["domain:papercusp-engineer"],
  provenance: [{ path: "roles[0].stack[0]", sourceRef: "identity:papercusp-engineer", sourceRevision: revision }],
});

async function seed() {
  const launchSpec = {
    v: 1,
    agent: "codex",
    workspaceId: workspace,
    harnessSlug: null,
    profile: "engineer",
    contextSize: "trimmed",
    personaTier: null,
    model: null,
    planSlug: null,
    launchedBy: "p015-r4-driver",
    autoMode: false,
    drainMode: false,
    loopArmed: false,
    fleet: { slug: null, role: null },
    stack: ["domain:papercusp-engineer"],
    specificationRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    stateRevision: "seed-new-state",
    principalId: owner,
    specificationArtifact: artifact("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    identityHistory: [{ stack: ["domain:papercusp-engineer"], specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state", specificationArtifact: artifact("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), recordedAt: new Date().toISOString() }],
  };
  const control = {
    stack: ["domain:papercusp-engineer"],
    activation: {
      schemaVersion: 1,
      attribution: { actorId: owner, principalId: owner, sessionId: owner },
      desired: { specificationRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", stateRevision: "seed-new-state" },
      prepared: null,
      applied: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" },
      status: "applied",
    },
  };
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent, current_plan_slug, current_files, host, pid, started_at, heartbeat_at, last_active_at, agent_role, pot_slug, capability_tags)
      VALUES (${owner}, ${label}, ${workspace}, 'p015-r4-driver', 'R-4 identity UI verification', null, '[]'::jsonb, 'isolated-verifier', ${process.pid}, now(), now(), now(), 'su', 'papercusp', '[]'::jsonb)
      ON CONFLICT (owner_id) DO UPDATE SET heartbeat_at = now(), last_active_at = now()
    `;
    const sessions = await tx`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, pid, label, started_at, coord_owner_id, agent, role, launch_spec)
      VALUES (${workspace}, 'console', ${process.pid}, ${label}, now(), ${owner}, 'codex', 'su', ${tx.json(launchSpec)})
      RETURNING id
    `;
    sessionId = Number(sessions[0].id);
    await tx`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, owner_label, source, intent, current_plan_slug, harness_slug, control_state, control_updated_at)
      VALUES (${owner}, ${workspace}, ${label}, 'p015-r4-driver', 'R-4 identity UI verification', null, null, ${tx.json(control)}, now())
      ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state, control_updated_at = now()
    `;
    await tx`
      INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id, owner_id, actor_id, principal_id, session_id, adv_session_id,
         transition_id, control_generation, phase, source, specification_revision,
         state_revision, stack_refs, failure, recorded_at)
      VALUES (${workspace}, ${owner}, ${owner}, ${owner}, ${owner}, ${sessionId},
        ${`fixture:${owner}:1`}, 1, 'applied', 'p015-r4-driver-seed',
        ${launchSpec.identityHistory[0].specificationRevision}, 'seed-old-state',
        ${tx.json(["domain:papercusp-engineer"])}, null, now())
    `;
  });
  evidence.steps.push({ label: "seed", owner, sessionId, workspace });
}

async function cleanup() {
  if (!isolationVerified) { await sql.end({ timeout: 2 }); return; }
  await sql`DELETE FROM harness_shared.session_identity_activation_events WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.session_briefs WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${workspace} AND coord_owner_id = ${owner}`;
  await sql`DELETE FROM harness_shared.coord_presence WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
  await sql.end({ timeout: 2 });
}

try {
  const [dbIdentity] = await sql`SHOW data_directory`;
  const dataRelative = relative(dirname(isolatedHome), dbIdentity.data_directory);
  if (!dataRelative || dataRelative.startsWith(`..${sep}`) || dataRelative === ".." || dataRelative.startsWith(sep)) {
    throw new Error("Postgres data_directory is outside this isolated verifier directory");
  }
  isolationVerified = true;
  evidence.databaseDataDirectory = dbIdentity.data_directory;
  evidence.frozenSpaIndexSha256 = createHash("sha256").update(readFileSync(resolve(required("VERIFY_TAURI_SPA_DIST"), "index.html"))).digest("hex");
  execFileSync("bash", [required("VERIFY_TAURI_LIVENESS_CHECK")], { stdio: "inherit", timeout: 15_000 });
  await seed();
  const rosterResponse = await fetch(`${required("VERIFY_TAURI_DEV_URL")}/api/adv/roster?workspace=${encodeURIComponent(workspace)}`, { signal: AbortSignal.timeout(30_000) });
  const roster = await rosterResponse.json();
  const fixture = roster.active?.find(x => x.ownerId === owner);
  if (!rosterResponse.ok || !fixture || fixture.sessionState === "ended") throw new Error("owned fixture is absent from active roster");
  evidence.rosterFixture = { ownerId: fixture.ownerId, sessionState: fixture.sessionState, label: fixture.label };
  run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=research-steward&identitySlot=domain`], "navigate-identities");
  settle();
  check(["--eval", `document.body.innerText.includes(${JSON.stringify(label)})`], "owned-agent-visible");
  check(["--selector", ".pc-identities__identity"], "identity-library-visible");
  if (realBackend) evalFile(captureRealFetch, "observe-real-fetch");
  else evalFile(patchFetch, "patch-fetch");

  check(["--selector", '[aria-label="Agent to manage"]', "--eval", `document.querySelector('[aria-label="Agent to manage"]')?.disabled === false && new URLSearchParams(location.search).get('identityAgent') === ${JSON.stringify(owner)}`], "owned-agent-selected");
  if (realBackend) {
    click('[aria-label="Inspect identity research-steward"]', "real-select-identity");
    settle();
    click(".pc-identities__actions button", "real-review-switch");
    settle();
    const reviewCall = JSON.parse(evalFile("window.__p015R4RealCalls.at(-1)", "real-review-response"));
    evidence.steps.push({ label: "real-review-response", response: reviewCall });
    if (reviewCall?.status !== 200) throw new Error(`real preview route refused the mutation: ${reviewCall?.body ?? JSON.stringify(reviewCall)}`);
    check(["--eval", "document.querySelector('.pc-identities__diff')?.textContent.includes('Revision diff') && !document.querySelector('[aria-label=\"Apply identity\"]')?.disabled"], "real-review-diff-visible");

    click('button[aria-label="Apply identity"]', "real-switch");
    settle();
    const switchResponse = JSON.parse(evalFile("window.__p015R4RealCalls.at(-1)", "real-switch-response"));
    evidence.steps.push({ label: "real-switch-response", response: switchResponse });
    if (switchResponse?.request?.action !== "switch" || switchResponse?.status !== 200) {
      throw new Error(`real switch route did not return a successful switch response: ${JSON.stringify(switchResponse)}`);
    }
    check(["--eval", "document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer')"], "real-switch-change-requested");
    const switchRequested = await observeActivation("real-switch-requested");
    if (switchRequested?.status !== "desired" || !switchRequested?.desired) {
      throw new Error(`real switch did not persist desired activation: ${JSON.stringify(switchRequested)}`);
    }
    await acknowledgeRealHost("real-switch-host-ack");
    settle();
    run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=research-steward&identitySlot=domain&identityTab=agent&refresh=${Date.now()}`], "real-switch-refresh");
    settle();
    const switchPage = JSON.parse(evalFile("JSON.stringify({ applied: document.body.innerText.includes('Identity applied'), requested: document.body.innerText.includes('Change requested'), stack: document.querySelector('.pc-identities__stack-card')?.textContent || '' })", "real-switch-state"));
    const switchApplied = await observeActivation("real-switch-applied");
    if (switchApplied?.status === "applied") {
      if (switchApplied.applied?.specificationRevision !== switchApplied.desired?.specificationRevision) {
        throw new Error(`real switch claimed applied without a matching activation receipt: ${JSON.stringify(switchApplied)}`);
      }
      check(["--eval", "(document.body.innerText.includes('Identity applied') || document.body.innerText.includes('Change requested')) && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "real-switch-applied");
    } else {
      check(["--eval", "document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "real-switch-pending-after-fresh-context-boundary");
      if (switchApplied?.status !== "desired" || switchApplied?.applied?.specificationRevision === switchApplied?.desired?.specificationRevision) {
        throw new Error(`real switch did not preserve the fresh-context boundary: ${JSON.stringify(switchApplied)}`);
      }
    }
    click('button[aria-label="Roll back identity"]', "real-rollback");
    settle();
    check(["--eval", "document.body.innerText.includes('Change requested')"], "real-rollback-change-requested");
    const rollbackRequested = await observeActivation("real-rollback-requested");
    if (rollbackRequested?.status !== "desired" || !rollbackRequested?.desired) {
      throw new Error(`real rollback did not persist desired activation: ${JSON.stringify(rollbackRequested)}`);
    }
    await acknowledgeRealHost("real-rollback-host-ack");
    settle();
    run(["navigate", `/settings/identities?identityAgent=${encodeURIComponent(owner)}&identityId=research-steward&identitySlot=domain&identityTab=agent&refresh=${Date.now()}`], "real-rollback-refresh");
    settle();
    const rollbackPage = JSON.parse(evalFile("JSON.stringify({ applied: document.body.innerText.includes('Identity applied'), requested: document.body.innerText.includes('Change requested'), stack: document.querySelector('.pc-identities__stack-card')?.textContent || '' })", "real-rollback-state"));
    const rollbackApplied = await observeActivation("real-rollback-applied");
    if (rollbackApplied?.status === "applied") {
      if (rollbackApplied.applied?.specificationRevision !== rollbackApplied.desired?.specificationRevision) {
        throw new Error(`real rollback claimed applied without a matching activation receipt: ${JSON.stringify(rollbackApplied)}`);
      }
      check(["--eval", "(document.body.innerText.includes('Identity applied') || document.body.innerText.includes('Change requested')) && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer')"], "real-rollback-applied");
    } else {
      check(["--eval", "document.body.innerText.includes('Change requested') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:research-steward')"], "real-rollback-pending-after-fresh-context-boundary");
      if (rollbackApplied?.status !== "desired" || rollbackApplied?.applied?.specificationRevision === rollbackApplied?.desired?.specificationRevision) {
        throw new Error(`real rollback did not preserve the fresh-context boundary: ${JSON.stringify(rollbackApplied)}`);
      }
    }
    evidence.hostActivationProven = switchApplied?.status === "applied" && rollbackApplied?.status === "applied";
    evidence.observed = ["owned-roster-selection", "real-backend-review", "real-switch-change-requested", switchApplied?.status === "applied" ? "real-switch-applied" : "real-switch-pending-after-fresh-context-boundary", "real-rollback-change-requested", rollbackApplied?.status === "applied" ? "real-rollback-applied" : "real-rollback-pending-after-fresh-context-boundary"];
  } else {
    click('[aria-label="Inspect identity research-steward"]', "select-identity");
    settle();
    click(".pc-identities__actions button", "review-switch");
    settle();
    check(["--eval", "document.querySelector('.pc-identities__diff')?.textContent.includes('configuration.roles[0]') && !document.querySelector('[aria-label=\"Apply identity\"]')?.disabled"], "review-diff-visible");

    click('button[aria-label="Apply identity"]', "forced-failure");
    settle();
    check(["--eval", "document.body.innerText.includes('Identity change failed: synthetic R-4 failure') && document.querySelector('.pc-identities__stack-card')?.textContent.includes('domain:papercusp-engineer')"], "failure-retains-applied-state");

    click(".pc-identities__actions button", "retry-review");
    settle();
    check(["--text", "Revision diff"], "retry-review-diff-visible");
    await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state, '{activation}', ${sql.json({ desired: { specificationRevision: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", stateRevision: "synthetic-r4-state" }, prepared: null, applied: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" }, status: "failed", failure: "synthetic R-4 failed activation; prior applied identity retained" })}::jsonb) WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    click('button[aria-label="Apply identity"]', "retry-apply");
    settle();
    check(["--text", "The change failed"], "retry-failure-state-visible");

    await sql`UPDATE harness_shared.session_briefs SET control_state = jsonb_set(control_state, '{activation}', ${sql.json({ desired: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" }, prepared: null, applied: { specificationRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stateRevision: "seed-old-state" }, status: "applied" })}::jsonb) WHERE workspace_id = ${workspace} AND owner_id = ${owner}`;
    click('button[aria-label="Roll back identity"]', "rollback");
    settle();
    check(["--eval", "document.body.innerText.includes('Identity applied')"], "rollback-applied-state-visible");
    check(["--eval", `JSON.stringify(window.__p015R4Calls.map(x => x.action)) === JSON.stringify(['preview','switch','preview','switch','rollback']) && window.__p015R4Calls.every(x => x.ownerId === ${JSON.stringify(owner)})`], "exact-owner-action-sequence");
    evidence.observed = ["owned-roster-selection", "review-diff", "failure-banner", "retry-review", "rollback-applied-banner"];
  }
  evalFile("({ calls: window.__p015R4Calls || window.__p015R4RealCalls, url: location.href, body: document.querySelector('.pc-identities').innerText })", "final-state");
  evidence.status = "pass";
} catch (error) {
  evidence.status = "fail";
  evidence.error = String(error?.stack || error);
  try {
    evidence.failureDom = JSON.parse(evalFile(`(() => {
      const selectors = ['.pc-identities','.pc-identities__library','.pc-identities__detail','.pc-identities__actions button'];
      const rect = e => { const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return {tag:e.tagName,cls:e.className,x:r.x,y:r.y,width:r.width,height:r.height,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollLeft:e.scrollLeft,overflowX:s.overflowX,display:s.display,minWidth:s.minWidth}; };
      const e=document.querySelector('.pc-identities__actions button');
      const ancestors=[]; for(let p=e;p;p=p.parentElement) ancestors.push(rect(p));
      return {url:location.href,body:document.querySelector('.pc-identities')?.innerText,calls:window.__p015R4Calls,viewport:{width:innerWidth,height:innerHeight},ancestors,targets:selectors.map(s=>({selector:s,rect:document.querySelector(s)?rect(document.querySelector(s)):null}))};
    })()`, 'failure-dom'));
  } catch (captureError) { evidence.captureError = String(captureError); }
  throw error;
} finally {
  writeFileSync(`${outDir}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  await cleanup().catch((error) => { evidence.cleanupError = String(error); evidence.status = "fail"; process.exitCode = 1; });
  writeFileSync(`${outDir}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
}

console.log(JSON.stringify({ ok: evidence.status === "pass", evidence: `${outDir}/evidence.json`, status: evidence.status, owner, realBackend, syntheticMutationResponses: !realBackend, hostActivationProven: evidence.hostActivationProven }));
}

// isCliEntry, not a hand-rolled import.meta.url comparison: esbuild gives every
// inlined module the BUNDLE entry's import.meta.url, so the hand-rolled form fires
// main() during desktop-sidecar host boot (EI-650 took embedded PG down that way).
if (isCliEntry(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
