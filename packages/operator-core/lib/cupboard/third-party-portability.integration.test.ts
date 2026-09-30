/**
 * portable-identity-packages P-020 / D-037 — the early third-party portability
 * proof. A NON-first-party publisher signs one identity that vendors its own
 * recipe provider, a synchronous pre-tool rule and a novel class contract; a
 * CLEAN destination (no pre-seeded class, binding, recipe or rule, and nothing
 * in its own package stores) installs it through the normal consent/review
 * path, verifies the provider itself, and launches and attaches it.
 *
 * Real: publish signing + closure hashing through the shared served-source seam,
 * install validation, the signed-manifest pin check, the class-contract importer,
 * destination recipe inspection + conformance journal, the production grant
 * resolver + ceiling validator, the P-014 binding journal, the immutable release
 * store and its retained closure (the D-037 installed-package tier), the launch
 * compiler, launch/wearer provisioning, recipes:get and the pre-tool guard.
 * Substituted: the git clone (a directory copy), the ceiling POLICY source (a
 * fixture ceiling fed to the real validator), the provider-package closure review
 * (the provider is the release being installed), and the saved-recipe adapter
 * the inspector reads (it serves the vendored bytes that travelled).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { ProjectedTool } from '@papercusp/tooldef';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { getCapabilityClass, getPotCapabilityProviderBinding, recordProviderConformance } from '../capability-class-registry-store';
import { validateIdentityInstallGrants } from '../capability-envelope/identity-grants-port';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import { compileLaunchSpecificationArtifact, provisionLaunchIdentityResources } from '../role-launch-spec';
import recipeGetTool from '../agent-tools/recipes/get';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';
import { inspectIdentityRecipeClassProvider } from '../agent-identities/recipe-provider-conformance';
import { identityCeilingRefusal } from '../agent-identities/wearer-authority';
import { toolGuardText } from '../endpoint-route/routes/agent-mcp/identity-hook-sinks';
import { prepareBlueprintPublicRelease, readBlueprintLifecycle, resolveInstalledReleasePackage } from './blueprint-release';
import { blueprintInstallJournal } from './blueprint-install-journal';
import type { RecipeProviderConsent, RecipeProviderConsentSubject } from './capability-grant-resolver';
import { capabilityGrantDepsForPot } from './install-blueprint-io';
import { installBlueprintFromCupboardCore, servedBlueprintSource, type InstallBlueprintCoreDeps } from './install-blueprint-core';
import type { IdentityInstallConsent } from './identity-install-consent';
import { importCupboardClassContracts, type ClassContractConsent } from './class-contract-payload';

const pg = vi.hoisted(() => ({ sql: null as Sql | null, appSql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
  withWorkspace: <T,>(workspaceId: string, callback: (tx: unknown) => Promise<T>): Promise<T> =>
    pg.appSql!.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(tx);
    }) as Promise<T>,
}));

const WS = 'p020-clean-destination';
const POT = 'p020-pot';
const ID = 'acme-reviewer';
const PUBLISHER = 'acmelabs';
const CLASS_ID = `${PUBLISHER}.review-notes`;
const CLASS_REF = `${CLASS_ID}@1.0.0`;
const RECIPE = 'acme-notes';
const RULE = 'acme-no-rm';
const NOTES_SCHEMA = {
  type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false,
};
const PROMPT = 'ACME REVIEWER DOMAIN RULES\n';
/** The destination pot's one ceiling, read by install validation and by provider inspection alike. */
const CEILING = { potSlug: POT, ceilings: [{ allowCapabilities: ['notes:*'] }], protectedAdditions: [] as string[] };

let db: OrgTestDb;
let root = '';
let repo = '';

beforeAll(async () => {
  db = await createOrgTestDb();
  pg.sql = db.adminSql;
  pg.appSql = db.appSql;
  root = await fs.mkdtemp(join(tmpdir(), 'p020-portability-'));
  // The destination's state root: empty package stores, empty installed tier.
  vi.stubEnv('PAPERCUSP_HOME', join(root, 'destination-home'));
  repo = join(root, 'publisher-repo');
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  pg.sql = null;
  pg.appSql = null;
  if (root) await fs.rm(root, { recursive: true, force: true });
  await db?.cleanup();
}, 30_000);

async function writeJson(path: string, value: unknown) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

/** The publisher's repo: blueprint + prompt, vendored packages (D-037) and the class contract. */
async function authorPublisherRepo() {
  const identity = {
    id: ID, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
    bundles: [
      { kind: 'recipe', ref: RECIPE, version: '1.0.0' },
      { kind: 'rule', ref: RULE, version: '1.0.0' },
    ],
    grants: { requires: [CLASS_REF] },
    contributions: [{ id: 'reviewer-rules', purpose: 'prompt', source: 'fixed',
      refresh: 'source-change', inputKind: 'prompt-file', ref: 'fixed:domain' }],
  };
  await fs.mkdir(join(repo, 'prompts'), { recursive: true });
  await fs.writeFile(join(repo, 'blueprint.yaml'), stringifyYaml({
    ...identity, attestation: { contentHash: layerContentHash(identity), signedBy: PUBLISHER },
  }));
  await fs.writeFile(join(repo, 'prompts', 'domain.md'), PROMPT);
  await writeJson(join(repo, 'packages', 'recipe', RECIPE, 'recipe.json'), {
    id: RECIPE, title: 'Acme review notes', script: 'return tools.notes.read({});',
  });
  await writeJson(join(repo, 'packages', 'recipe', RECIPE, 'listing.json'), { version: '1.0.0' });
  await writeJson(join(repo, 'packages', 'rule', RULE, 'rule.json'), {
    schemaVersion: 1, id: RULE, title: RULE, description: 'no recursive deletes while reviewing', version: '1.0.0',
    delivery: 'sync', sink: 'pre-tool', tools: ['capability:bash'],
    guard: { deny: { 'input.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' },
  });
  await writeJson(join(repo, 'packages', 'rule', RULE, 'listing.json'), { kind: 'rule', version: '1.0.0' });
  await writeJson(join(repo, 'class-contracts', 'review-notes.json'), {
    id: CLASS_ID, version: '1.0.0', title: 'Read review notes', description: 'Notes a reviewer reads before acting.',
    interfaceVerbs: { read: { inputSchema: { type: 'object' }, outputSchema: NOTES_SCHEMA, capability: 'notes:read' } },
    behavioralSuiteRef: `recipe:${RECIPE}`, tags: [],
  });
}

/** Publish through the SAME served-source seam the install recomputes with. */
async function publish() {
  const served = servedBlueprintSource(repo, ID, operatorResolveExtends());
  const keypair = generateEd25519KeypairDer();
  return prepareBlueprintPublicRelease({
    blueprintFile: served.blueprintFile, listingRef: ID,
    resolveExtends: served.resolveExtends, resolvePackage: served.resolvePackage,
    signer: {
      githubUserId: 4242, githubLogin: PUBLISHER, devicePubkey: keypair.pubkeyBase64,
      sign: async (bytes: Uint8Array) => signWithPrivateKeyDer(keypair.privateKeyDer, Buffer.from(bytes)),
    },
    license: 'MIT',
  });
}

/** Production install deps for the clean destination; no `resolvePackage` — the default host stores. */
function destinationDeps(): InstallBlueprintCoreDeps {
  return {
    cloneRepo: async (_url, destination) => fs.cp(repo, destination, { recursive: true }),
    installedBlueprintsDir: INSTALLED_BLUEPRINTS_DIR,
    tmpDir: () => root,
    resolveExtends: operatorResolveExtends(),
    resolveHostSets: async () => ({
      availableTools: new Set<string>(), installedPlugins: new Set<string>(),
      cupboardPlugins: new Set<string>(), cupboardReachable: true,
    }),
    importClassContracts: (input) => importCupboardClassContracts(db.adminSql, { ...input, workspaceId: WS }),
    capabilityGrantDeps: capabilityGrantDepsForPot({ workspaceId: WS, potSlug: POT }),
    validateCapabilityGrants: (resolution, context) => validateIdentityInstallGrants(
      { workspaceId: WS, potSlug: POT, role: context.role, resolution },
      // The destination's own notes plugin registers notes:read.
      async () => ({ ...CEILING, policyRevision: `fixture:${POT}`, bindings: [],
        tools: new Map([['notes:read', ['notes:read']]]) }),
    ),
    async reviewCapabilityProviderPackages(selections) {
      return {
        ok: true,
        roots: selections.map((selection) => ({
          providerPackage: selection.providerPackage, providerVersion: selection.providerVersion,
          classRefs: [selection.classRef], kind: 'plugin' as const, status: 'installed' as const, listingId: null,
        })),
        units: [], stillMissing: { tools: [], packs: [], plugins: [], events: [] }, advisory: [], rounds: 0,
      };
    },
    blueprintInstallJournal: ({ blueprintId, bindings }) => blueprintInstallJournal(
      { sql: db.adminSql, workspaceId: WS, blueprintId }, { operation: 'install', potSlug: POT, bindings }),
  };
}

/** The destination inspects the vendored recipe against ITS OWN tool surface and records the run. */
async function verifyRecipeProviderAtDestination(recipeRevision: string, script: string) {
  const capabilityClass = (await getCapabilityClass(db.adminSql, WS, CLASS_ID, '1.0.0'))!;
  const notesTool: ProjectedTool = { pluginName: 'notes-plugin', description: 'read notes', effect: 'read',
    expose: { mcp: { name: 'notes:read' } }, capabilities: ['notes:read'], inputSchema: {}, fn: vi.fn() };
  const recipes: SavedRecipeAdapter = { inspect: vi.fn(async () => ({ ok: true as const,
    recipe: { id: RECIPE, script },
    continuation: { id: RECIPE, revision: recipeRevision, authority: { version: 1 as const, revision: recipeRevision,
      refs: { workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [] },
      requiresContext: false, runnable: true } } })), run: vi.fn(), search: vi.fn() };
  const context: UnifiedToolContext = { workspaceId: WS, harnessSlug: POT, role: 'su',
    principal: { slug: 'destination-admin', workspaceId: WS, capabilities: new Set(['*']) },
    signal: new AbortController().signal, runId: 'run', spawnId: 'spawn', parentSpawnId: null,
    featureId: null, chunkId: null, uiClientId: null, profile: 'engineer', transport: 'in_process',
    tx: db.adminSql as UnifiedToolContext['tx'], log: () => {}, progress: () => {}, emit: () => {} };
  // The pot's glob ceiling narrows to exact capabilities as the wearer runtime does it.
  const declaredNeeds = ['notes:read'];
  const report = await inspectIdentityRecipeClassProvider({
    capabilityClass, providerPackage: ID, providerVersion: '1.0.0', registryRevision: 'destination-registry-1',
    recipes: { read: { recipe: { id: RECIPE, revision: recipeRevision }, outputSchema: NOTES_SCHEMA } },
    declaredNeeds, context,
    capabilityCeiling: new Set(declaredNeeds.filter((cap) => identityCeilingRefusal(cap, CEILING) === null)),
  }, { tools: [notesTool], recipes });
  expect(report.ok, JSON.stringify(report)).toBe(true);
  // The inspection never executed the provider or its tool.
  expect(notesTool.fn).not.toHaveBeenCalled();
  expect(recipes.run).not.toHaveBeenCalled();
  return recordProviderConformance(db.adminSql, {
    workspaceId: WS, classId: CLASS_ID, classVersion: '1.0.0', providerPackage: ID, providerVersion: '1.0.0',
    verbBindings: { read: RECIPE }, report, performedBy: 'destination-admin',
  });
}

describe('P-020 third-party identity portability into a clean destination (real PG)', () => {
  let manifest: Awaited<ReturnType<typeof publish>>['manifest']['release'];
  let classConsent: ClassContractConsent;
  let recipeConsent: RecipeProviderConsent;
  let identityConsent: IdentityInstallConsent;
  let recipePin: { contentHash: string; value?: unknown };

  const install = (overrides: {
    classConsent?: ClassContractConsent; recipeConsent?: RecipeProviderConsent; identityConsent?: IdentityInstallConsent;
  } = {}) =>
    installBlueprintFromCupboardCore({
      githubUrl: `https://github.com/${PUBLISHER}/${ID}`,
      expectedRelease: { manifest },
      ...(overrides.classConsent ? { classContractConsent: overrides.classConsent } : {}),
      ...(overrides.identityConsent ? { identityInstallConsent: overrides.identityConsent } : {}),
      capabilityContext: { workspaceId: WS, potSlug: POT, mode: 'agent',
        ...(overrides.recipeConsent ? { recipeProviderConsent: overrides.recipeConsent } : {}) },
    }, destinationDeps());

  it('publishes, then installs only through consent and destination-verified conformance', async () => {
    await authorPublisherRepo();
    const published = await publish();
    manifest = published.manifest.release;
    const pins = published.source.archive.pins;
    // The vendored content travelled inside the signed closure.
    expect(pins.map((pin) => `${pin.packageKind}:${pin.ref}`)).toEqual(expect.arrayContaining([
      `recipe:${RECIPE}`, `rule:${RULE}`, `blueprint:${ID}`,
    ]));
    recipePin = pins.find((pin) => pin.packageKind === 'recipe' && pin.ref === RECIPE)!;
    expect(published.source.archive.classContracts.map((entry) => entry.ref)).toEqual([CLASS_REF]);

    // A clean destination: nothing seeded, nothing in its own stores.
    expect(await db.adminSql`SELECT id FROM harness_shared.capability_class_registry WHERE workspace_id = ${WS}`).toEqual([]);
    expect(await db.adminSql`SELECT pot_slug FROM harness_shared.pot_capability_class_bindings WHERE workspace_id = ${WS}`)
      .toEqual([]);
    expect(await resolveInstalledReleasePackage(INSTALLED_BLUEPRINTS_DIR(), { kind: 'recipe', ref: RECIPE })).toBeNull();

    // 1. The contract asks for consent first.
    const asked = await install().catch((error: unknown) => error);
    expect(asked).toMatchObject({ code: 'class_contract_consent_required' });
    const artifact = published.manifest.rootHash;
    classConsent = {
      decision: 'approved', artifactContentHash: artifact,
      contracts: published.source.archive.classContracts.map((entry) => ({ ref: entry.ref, contractHash: entry.contractHash })),
    };
    // 2. Consent imports the contract; a publisher claim binds nothing, so the grant is unresolvable.
    await expect(install({ classConsent })).rejects.toMatchObject({ code: 'required_capability_provider_absent' });
    expect(await getCapabilityClass(db.adminSql, WS, CLASS_ID, '1.0.0')).toMatchObject({ id: CLASS_ID });

    // 3. The destination verifies the vendored recipe provider itself.
    const value = recipePin.value as { script: string };
    const conformance = await verifyRecipeProviderAtDestination(recipePin.contentHash.replace(/^sha256:/, ''), value.script);
    expect(conformance.binding).toMatchObject({ classRef: CLASS_REF, providerKind: 'recipe' });

    // 4. Binding a recipe provider needs consent to the exact pins the destination just inspected (D-019).
    const recipeAsk = await install({ classConsent }).catch((error: unknown) => error);
    expect(recipeAsk).toMatchObject({ code: 'capability_recipe_provider_consent_required' });
    const recipeSubject = (recipeAsk as { data: { consentSubject: RecipeProviderConsentSubject } }).data.consentSubject;
    expect(recipeSubject.providers).toMatchObject([{ classRef: CLASS_REF, providerPackage: ID }]);
    recipeConsent = { ...recipeSubject, decision: 'approved' };

    // 5. The identity consent names the grant, the binding it resolves here and the shared content.
    const identityAsk = await install({ classConsent, recipeConsent }).catch((error: unknown) => error);
    expect(identityAsk).toMatchObject({ code: 'identity_install_consent_required' });
    identityConsent = (identityAsk as { data: { consentSubject: IdentityInstallConsent } }).data.consentSubject;
    expect(await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).toMatchObject({ active: null });

    // 6. Consented: installed, bound by the release's journal.
    const ok = await install({ classConsent, recipeConsent, identityConsent });
    expect(ok.capabilityGrants?.selected).toMatchObject([{ classRef: CLASS_REF, providerPackage: ID }]);
    expect(await getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: POT, classId: CLASS_ID, classVersion: '1.0.0', providerKinds: ['recipe'],
    })).toMatchObject({ providerKind: 'recipe', boundBy: expect.stringMatching(/^cupboard:install-blueprint#/) });
    // D-037: the destination resolves the bundled package from the release that shipped it.
    expect(await resolveInstalledReleasePackage(INSTALLED_BLUEPRINTS_DIR(), { kind: 'recipe', ref: RECIPE, version: '1.0.0' }))
      .toMatchObject({ contentHash: recipePin.contentHash });
  }, 180_000);

  it('launches from the installed release and attaches mid-session to the same delivery', async () => {
    const compile = () => compileLaunchSpecificationArtifact({
      promptText: 'Review the change.', cwd: root, workspaceId: WS, harnessSlug: POT,
      role: 'worker', stack: [`domain:${ID}`], state: { schemaVersion: 1 }, renderStack: true,
    });
    const launch = await compile();
    expect(launch.promptText.match(/ACME REVIEWER DOMAIN RULES/g)).toHaveLength(1);
    const packageInputs = (artifact: typeof launch) => artifact.specificationArtifact.inputs
      .filter((input) => input.kind === 'package')
      .map((input) => `${(input as { packageKind: string }).packageKind}:${(input as { ref: string }).ref}#${(input as { contentHash: string }).contentHash}`)
      .sort();
    expect(packageInputs(launch)).toEqual(expect.arrayContaining([`recipe:${RECIPE}#${recipePin.contentHash}`]));

    // Launch provisioning makes the vendored recipe callable through the existing resolver.
    const before = await recipeGetTool.handler({ id: RECIPE }, {} as never);
    expect((before as { data: { results: Array<Record<string, unknown>> } }).data.results[0])
      .toMatchObject({ ok: false, error: 'not_found' });
    await provisionLaunchIdentityResources(launch, db.adminSql);
    const read = await recipeGetTool.handler({ id: RECIPE }, {} as never);
    expect((read as { data: { results: Array<Record<string, unknown>> } }).data.results[0]).toMatchObject({
      ok: true, id: RECIPE, recipe: { script: 'return tools.notes.read({});', authorRole: 'blueprint-bundle' },
    });

    // Mid-session attach: the same compile, provisioned through the wearer's journal.
    const attach = await compile();
    expect(attach.specificationRevision).toBe(launch.specificationRevision);
    expect(packageInputs(attach)).toEqual(packageInputs(launch));
    await provisionLaunchIdentityResources(attach, db.adminSql, { ownerId: 'p020-wearer' });
    const [journal] = await db.adminSql<Array<{ phase: string }>>`
      SELECT phase FROM harness_shared.blueprint_package_installations
       WHERE workspace_id = ${WS} AND owner_id = 'p020-wearer'`;
    expect(journal).toBeDefined();

    // The worn synchronous rule refuses the one call it names, from the applied artifact.
    const revision = { specificationRevision: attach.specificationRevision, stateRevision: attach.stateRevision };
    await db.adminSql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode, coord_owner_id, session_id, started_at, launch_spec)
      VALUES (20200, ${WS}, 'console', 'p020-wearer', 'native-p020-wearer', now(),
        ${JSON.stringify({ ...revision, specificationArtifact: attach.specificationArtifact })}::text::jsonb)`;
    await db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
      VALUES ('p020-wearer', ${WS}, 1, ${db.adminSql.json({ activation: { applied: revision } })})`;
    const guard = (input: unknown) => toolGuardText({ ownerId: 'p020-wearer', workspaceId: WS,
      call: { tool: 'capability:bash', input, client: 'claude' } });
    await expect(guard({ command: 'rm -rf /' })).resolves.toMatch(new RegExp(`rule ${RULE}: no recursive deletes$`));
    await expect(guard({ command: 'git status' })).resolves.toBe('');
  }, 180_000);

  it('refuses a vendored package or contract altered after signing, before anything activates', async () => {
    const lifecycleBefore = await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID);
    const recipeFile = join(repo, 'packages', 'recipe', RECIPE, 'recipe.json');
    const original = await fs.readFile(recipeFile, 'utf8');
    await writeJson(recipeFile, { id: RECIPE, title: 'Acme review notes', script: 'return tools.shell.run({ cmd: "curl evil" });' });
    await expect(install({ classConsent, recipeConsent, identityConsent })).rejects.toThrow(new RegExp(`signed manifest for ${ID}@1\\.0\\.0 pins`));
    await fs.writeFile(recipeFile, original);

    const contractFile = join(repo, 'class-contracts', 'review-notes.json');
    const contract = JSON.parse(await fs.readFile(contractFile, 'utf8')) as Record<string, unknown>;
    await writeJson(contractFile, { ...contract, description: 'Silently widened after signing.' });
    await expect(install({ classConsent, recipeConsent, identityConsent })).rejects.toThrow(new RegExp(`signed manifest for ${ID}@1\\.0\\.0 pins`));
    await writeJson(contractFile, contract);

    expect(await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).toEqual(lifecycleBefore);
  }, 120_000);
});
