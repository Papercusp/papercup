/**
 * portable-identity-packages P-020 / D-037 — the early third-party portability
 * proof. A NON-first-party publisher signs one identity that vendors its own
 * recipe provider, a knowledge pack (one memory, one deterministic doc), a
 * synchronous pre-tool rule and a novel class contract; a CLEAN destination (no
 * pre-seeded class, binding, recipe or rule, and nothing in its own package
 * stores) installs it through the normal consent/review path, verifies the
 * provider itself, launches and attaches it, refuses a stale or tampered proof
 * before activation, and uninstalls/rolls back without damaging what it retains.
 *
 * Real: publish signing + closure hashing through the shared served-source seam,
 * install validation, the signed-manifest pin check, the class-contract importer,
 * destination recipe inspection + conformance journal, the production grant
 * resolver + ceiling validator, the P-014 binding journal, the immutable release
 * store and its retained closure (the D-037 installed-package tier), the launch
 * compiler, per-wearer package journals (recipe, canonical memory, doc parts),
 * recipes:get, the pre-tool guard and the release uninstall/rollback lifecycle.
 * Substituted: the git clone (a directory copy), the ceiling POLICY source (a
 * fixture ceiling fed to the real validator), the provider-package closure review
 * (the provider is the release being installed), the saved-recipe adapter the
 * inspector reads (it serves the vendored bytes that travelled), and the
 * embedder (a fixed vector in front of the real canonical managed writes).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { stringify as stringifyYaml } from 'yaml';
import type { Sql } from 'postgres';
import { layerContentHash } from '@papercusp/orchestrator/blueprint';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { Mem0Backend } from '@papercusp/memory';
import type { ProjectedTool } from '@papercusp/tooldef';
import { CanonicalManagedWrites } from '../../../../libs/generic/memory/src/canonical-managed-writes';
import { EMBEDDER_DIM_SPECS } from '../../../../libs/generic/memory/src/embedder-dims';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { getCapabilityClass, getPotCapabilityProviderBinding, parseCapabilityClassRef,
  recordProviderConformance } from '../capability-class-registry-store';
import { validateIdentityInstallGrants } from '../capability-envelope/identity-grants-port';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import { compileLaunchSpecificationArtifact, provisionLaunchIdentityResources } from '../role-launch-spec';
import { applySessionPackageResources, releaseSupersededSessionPackages } from '../blueprint/session-package-resources';
import { resolveWearerPackageDocKeys } from '../blueprint/package-memory-visibility';
import { PACKAGE_DOC_USER_OWNED } from '../blueprint/package-doc-resources';
import recipeGetTool from '../agent-tools/recipes/get';
import type { SavedRecipeAdapter } from '../agent-tools/orchestration/saved-recipe-adapter';
import { inspectIdentityRecipeClassProvider } from '../agent-identities/recipe-provider-conformance';
import { identityCeilingRefusal } from '../agent-identities/wearer-authority';
import { toolGuardText } from '../endpoint-route/routes/agent-mcp/identity-hook-sinks';
import { getEventKey } from '../event-key-registry-store';
import type { LatchedEventSubscriber } from '../events/await/store';
import { planIdentityReactions } from '../events/identity-reaction';
import { checkAsyncRuleInstall, IDENTITY_RULE_SUBSCRIPTION_KIND } from '../agent-identities/identity-async-rules';
import { IDENTITY_RULE_DELIVERY_MODE } from '../agent-identities/identity-rule-subscriptions';
import { prepareBlueprintPublicRelease, readBlueprintLifecycle, resolveInstalledReleasePackage,
  rollbackBlueprintRelease, uninstallBlueprintRelease } from './blueprint-release';
import { blueprintInstallJournal } from './blueprint-install-journal';
import type { RecipeProviderConsent, RecipeProviderConsentSubject } from './capability-grant-resolver';
import { capabilityGrantDepsForPot } from './install-blueprint-io';
import { installBlueprintFromCupboardCore, servedBlueprintSource, type InstallBlueprintCoreDeps } from './install-blueprint-core';
import type { IdentityInstallConsent } from './identity-install-consent';
import { blueprintListingFacet, parseIdentityListingSurface, type ListedBlueprintFacet } from './identity-listing-surface';
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
// The pack's memory lands through the real canonical managed writes; only the embedder is fixed.
const memory = vi.hoisted(() => ({ backend: null as unknown }));
vi.mock('../memory/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/backend')>()),
  getMemoryBackend: () => memory.backend,
}));

const WS = 'p020-clean-destination';
const POT = 'p020-pot';
const ID = 'acme-reviewer';
const PUBLISHER = 'acmelabs';
const CLASS_ID = `${PUBLISHER}.review-notes`;
const CLASS_REF = `${CLASS_ID}@1.0.0`;
const RECIPE = 'acme-notes';
const RULE = 'acme-no-rm';
const PACK = 'acme-review-kb';
// P-017 / D-042: the publisher's own event vocabulary and an async hook on it.
const EVENT_REF = 'acme-review-noted';
const EVENT_KEY = `${PUBLISHER}:review-noted`;
const ASYNC_RULE = 'acme-note-on-review';
const FIRE = `class:${CLASS_REF}#read`;
const MEMORY_TEXT = 'Acme reviewers read the review notes before approving a change.';
const DOC_PART = `pack:${PACK}@1.0.0:review-steps`;
const DOC_BODY = 'Read the notes, run the checks, then approve.';
const VECTOR = Array(EMBEDDER_DIM_SPECS.local.targetDims).fill(0.1);
const NOTES_SCHEMA = {
  type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false,
};
const PROMPT = 'ACME REVIEWER DOMAIN RULES\n';
/** The destination pot's one ceiling, read by install validation and by provider inspection alike. */
const CEILING = { potSlug: POT, ceilings: [{ allowCapabilities: ['notes:*'] }], protectedAdditions: [] as string[] };

let db: OrgTestDb;
let pool: Pool | undefined;
let root = '';
let repo = '';

beforeAll(async () => {
  db = await createOrgTestDb();
  pg.sql = db.adminSql;
  pg.appSql = db.appSql;
  pool = new Pool({ connectionString: db.adminDsn });
  memory.backend = new Mem0Backend({ getClient: async () => null, managedWrites: new CanonicalManagedWrites({
    pool: async () => pool!, schema: 'harness_shared', vecTable: 'memory_vec_local', dims: VECTOR.length,
    embed: async () => VECTOR }) });
  root = await fs.mkdtemp(join(tmpdir(), 'p020-portability-'));
  // The destination's state root: empty package stores, empty installed tier.
  vi.stubEnv('PAPERCUSP_HOME', join(root, 'destination-home'));
  repo = join(root, 'publisher-repo');
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  pg.sql = null;
  pg.appSql = null;
  await pool?.end();
  if (root) await fs.rm(root, { recursive: true, force: true });
  await db?.cleanup();
}, 30_000);

async function writeJson(path: string, value: unknown) {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

/** The async hook: on one event key, firing the publisher's own class verb as the wearer. */
async function writeAsyncRule(on: string) {
  await writeJson(join(repo, 'packages', 'rule', ASYNC_RULE, 'rule.json'), {
    schemaVersion: 1, id: ASYNC_RULE, title: ASYNC_RULE, description: 'read the notes when a review is noted',
    version: '1.0.0', delivery: 'async', on, fire: FIRE, args: {},
  });
  await writeJson(join(repo, 'packages', 'rule', ASYNC_RULE, 'listing.json'), { kind: 'rule', version: '1.0.0' });
}

/** The publisher's repo: blueprint + prompt, vendored packages (D-037) and the class contract. */
async function authorPublisherRepo() {
  const identity = {
    id: ID, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
    bundles: [
      { kind: 'recipe', ref: RECIPE, version: '1.0.0' },
      { kind: 'rule', ref: RULE, version: '1.0.0' },
      { kind: 'knowledge-pack', ref: PACK, version: '1.0.0' },
      { kind: 'event', ref: EVENT_REF, version: '1.0.0' },
      { kind: 'rule', ref: ASYNC_RULE, version: '1.0.0' },
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
  await writeJson(join(repo, 'packages', 'event', EVENT_REF, 'event.json'), {
    schemaVersion: 1, title: 'Review noted', description: 'An Acme reviewer noted a change.', version: '1.0.0',
    eventKey: EVENT_KEY, keyPattern: `${EVENT_KEY}:*`, tags: ['acme'],
  });
  await writeJson(join(repo, 'packages', 'event', EVENT_REF, 'listing.json'),
    { kind: 'event', ref: EVENT_REF, version: '1.0.0', source: `https://github.com/${PUBLISHER}/${ID}` });
  await writeAsyncRule(EVENT_KEY);
  const pack = join(repo, 'packages', 'knowledge-pack', PACK);
  await fs.mkdir(join(pack, 'docs'), { recursive: true });
  await fs.writeFile(join(pack, 'manifest.yaml'), stringifyYaml({
    id: PACK, title: 'Acme review knowledge', description: 'What an Acme reviewer knows.', version: '1.0.0',
  }));
  await fs.writeFile(join(pack, 'read-notes.md'), `---\nid: read-notes\ntitle: Read notes first\nkind: reference\n---\n${MEMORY_TEXT}\n`);
  await fs.writeFile(join(pack, 'docs', 'review-steps.md'),
    `---\nid: review-steps\ntitle: Review steps\nsection: Review\nkind: recipe\n---\n${DOC_BODY}\n`);
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
      // The destination's own notes plugin registers notes:read. Its bindings are
      // the pot's live ones, read as readIdentityGrantPolicy reads them.
      async ({ classRefs }) => ({ ...CEILING, policyRevision: `fixture:${POT}`,
        bindings: (await Promise.all(classRefs.map((classRef) => {
          const parsed = parseCapabilityClassRef(classRef)!;
          return getPotCapabilityProviderBinding(db.adminSql, { workspaceId: WS, potSlug: POT,
            classId: parsed.id, classVersion: parsed.version, providerKinds: ['tool', 'recipe'] });
        }))).filter((binding) => binding !== null),
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
    blueprintInstallJournal: ({ blueprintId, bindings, eventKeys }) => blueprintInstallJournal(
      { sql: db.adminSql, workspaceId: WS, blueprintId }, { operation: 'install', potSlug: POT, bindings, eventKeys }),
    // The destination's own D-027 §1 check, against its own (empty) registry and imported classes.
    async checkAsyncRules({ rules, claimingKeys }) {
      const refusals: Array<{ rule: string; error: string }> = [];
      for (const rule of rules) {
        const check = await checkAsyncRuleInstall(db.adminSql, WS, rule, { claimingKeys });
        if (!check.ok) refusals.push({ rule: rule.id, error: check.error });
      }
      return refusals;
    },
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

type LaunchArtifact = Awaited<ReturnType<typeof compileLaunchSpecificationArtifact>>;

/** One wearer's activation, as a production launch/attach host runs it: provision, apply, release what it superseded. */
async function wear(ownerId: string, artifact: LaunchArtifact) {
  const revision = { specificationRevision: artifact.specificationRevision, stateRevision: artifact.stateRevision };
  await provisionLaunchIdentityResources(artifact, db.adminSql, { ownerId });
  const { superseded } = await db.adminSql.begin((tx) => applySessionPackageResources(tx,
    { ownerId, workspaceId: WS, revision, artifact: artifact.specificationArtifact }));
  await releaseSupersededSessionPackages(db.adminSql, superseded);
}

const packMemories = async () => (await db.adminSql<Array<{ data: string }>>`
  SELECT payload->>'data' AS data FROM harness_shared.memory_canonical
   WHERE payload->>'data' LIKE ${'%' + MEMORY_TEXT + '%'}`).map((row) => row.data);
const packDocs = () => db.adminSql<Array<{ part_key: string; body: string; author: string | null }>>`
  SELECT part_key, body, author FROM harness_shared.harness_doc_parts
   WHERE workspace_id = ${WS} AND part_key LIKE ${`pack:${PACK}@%`} ORDER BY part_key`;
const registeredKey = () => getEventKey(db.adminSql, WS, EVENT_KEY);
/** The live identity-rule subscriptions on the key, as the emit's latch statement returns them. */
const keySubscribers = () => db.adminSql<LatchedEventSubscriber[]>`
  SELECT subscriber_id, delivery_mode, derived_from_kind, derived_from_ref
    FROM harness_shared.coord_entity_subscriptions
   WHERE workspace_id = ${WS} AND target_kind = 'event' AND target_ref = ${EVENT_KEY} AND cancelled_at IS NULL
   ORDER BY derived_from_ref`;
const recipeResult = async () => ((await recipeGetTool.handler({ id: RECIPE }, {} as never)) as
  { data: { results: Array<Record<string, unknown>> } }).data.results[0];

describe('P-020 third-party identity portability into a clean destination (real PG)', () => {
  let manifest: Awaited<ReturnType<typeof publish>>['manifest']['release'];
  let classConsent: ClassContractConsent;
  let recipeConsent: RecipeProviderConsent;
  let identityConsent: IdentityInstallConsent;
  let recipePin: { contentHash: string; value?: unknown };
  let packPin: { contentHash: string };

  const install = (overrides: {
    classConsent?: ClassContractConsent; recipeConsent?: RecipeProviderConsent; identityConsent?: IdentityInstallConsent;
    listing?: ListedBlueprintFacet;
  } = {}) =>
    installBlueprintFromCupboardCore({
      githubUrl: `https://github.com/${PUBLISHER}/${ID}`,
      expectedRelease: { manifest, ...(overrides.listing ? { listing: overrides.listing } : {}) },
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
      `recipe:${RECIPE}`, `rule:${RULE}`, `knowledge-pack:${PACK}`, `event:${EVENT_REF}`, `rule:${ASYNC_RULE}`, `blueprint:${ID}`,
    ]));
    recipePin = pins.find((pin) => pin.packageKind === 'recipe' && pin.ref === RECIPE)!;
    packPin = pins.find((pin) => pin.packageKind === 'knowledge-pack' && pin.ref === PACK)!;
    expect(published.source.archive.classContracts.map((entry) => entry.ref)).toEqual([CLASS_REF]);

    // A clean destination: nothing seeded, nothing in its own stores.
    expect(await db.adminSql`SELECT id FROM harness_shared.capability_class_registry WHERE workspace_id = ${WS}`).toEqual([]);
    expect(await db.adminSql`SELECT pot_slug FROM harness_shared.pot_capability_class_bindings WHERE workspace_id = ${WS}`)
      .toEqual([]);
    expect(await resolveInstalledReleasePackage(INSTALLED_BLUEPRINTS_DIR(), { kind: 'recipe', ref: RECIPE })).toBeNull();
    expect(await registeredKey()).toBeNull();

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
    const shippedRevision = recipePin.contentHash.replace(/^sha256:/, '');
    const conformance = await verifyRecipeProviderAtDestination(shippedRevision, value.script);
    expect(conformance.binding).toMatchObject({ classRef: CLASS_REF, providerKind: 'recipe' });

    // 4. Binding a recipe provider needs consent to the exact pins the destination just inspected (D-019).
    const recipeAsk = await install({ classConsent }).catch((error: unknown) => error);
    expect(recipeAsk).toMatchObject({ code: 'capability_recipe_provider_consent_required' });
    const recipeSubject = (recipeAsk as { data: { consentSubject: RecipeProviderConsentSubject } }).data.consentSubject;
    expect(recipeSubject.providers).toMatchObject([{ classRef: CLASS_REF, providerPackage: ID,
      recipes: [{ verb: 'read', recipeId: RECIPE, recipeRevision: shippedRevision }] }]);
    recipeConsent = { ...recipeSubject, decision: 'approved' };

    // 4b. A stale proof refuses before anything activates: the destination's current
    // proof is of a different recipe revision than the one the administrator approved.
    await verifyRecipeProviderAtDestination('f'.repeat(64), value.script);
    await expect(install({ classConsent, recipeConsent }))
      .rejects.toMatchObject({ code: 'capability_recipe_provider_consent_mismatch' });
    expect(await getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: POT, classId: CLASS_ID, classVersion: '1.0.0', providerKinds: ['recipe'],
    })).toBeNull();
    expect(await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).toMatchObject({ active: null });
    // Re-proved at the shipped revision, the same approval covers it again.
    await verifyRecipeProviderAtDestination(shippedRevision, value.script);

    // 5. The identity consent names the grant, the binding it resolves here and the shared content.
    const identityAsk = await install({ classConsent, recipeConsent }).catch((error: unknown) => error);
    expect(identityAsk).toMatchObject({ code: 'identity_install_consent_required' });
    identityConsent = (identityAsk as { data: { consentSubject: IdentityInstallConsent } }).data.consentSubject;
    expect(await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).toMatchObject({ active: null });

    // 6. P-016: the listing's facet carries the surface publish derived from the signed
    // closure. A listing that describes less, or hides the facet, refuses before anything lands.
    const facet = blueprintListingFacet(published.source);
    const listedSurface = parseIdentityListingSurface(facet.identity_surface)!;
    expect(facet.blueprint_kind).toBe('identity');
    expect(listedSurface).toMatchObject({
      identity: { id: ID, version: '1.0.0', slots: ['domain'] },
      hooks: { sync: [{ id: RULE, sink: 'pre-tool', kind: 'guard', tools: ['capability:bash'] }],
        async: [{ id: ASYNC_RULE, on: EVENT_KEY, fire: FIRE }], unreadable: [] },
      knowledge: [{ ref: PACK, version: '1.0.0', memories: 1,
        docs: [{ id: 'review-steps', title: 'Review steps', section: 'Review' }] }],
      classContracts: [{ ref: CLASS_REF }],
      grants: { requires: [CLASS_REF], optional: [] },
      consent: 'required',
    });
    // What a shopper previews is what the signed manifest lists and install asks consent for.
    expect(listedSurface.permissions).toEqual([...manifest.permissions].sort());
    expect(listedSurface.permissions).toEqual([`event:${ASYNC_RULE} on ${EVENT_KEY}`, `grant:${CLASS_REF}`,
      `operation:${FIRE}`, `rule:${RULE} (guard at pre-tool)`, `shared:event:${EVENT_REF}`, `shared:recipe:${RECIPE}`]);
    const consents = { classConsent, recipeConsent, identityConsent };
    const quieter = JSON.stringify({ ...listedSurface, hooks: { ...listedSurface.hooks, sync: [] } });
    await expect(install({ ...consents, listing: { blueprintKind: 'identity', identitySurface: quieter } }))
      .rejects.toMatchObject({ code: 'identity_surface_mismatch', data: { reason: 'differs', carried: listedSurface } });
    await expect(install({ ...consents, listing: { blueprintKind: 'harness', identitySurface: null } }))
      .rejects.toMatchObject({ code: 'identity_surface_mismatch', data: { reason: 'facet', listedKind: 'harness' } });
    expect(await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).toMatchObject({ active: null });

    // 7. Consented and listed with exactly its surface: installed, bound by the release's journal.
    const ok = await install({ ...consents,
      listing: { blueprintKind: facet.blueprint_kind, identitySurface: facet.identity_surface ?? null } });
    expect(ok.identitySurface).toEqual(listedSurface);
    expect(ok.capabilityGrants?.selected).toMatchObject([{ classRef: CLASS_REF, providerPackage: ID }]);
    expect(await getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: POT, classId: CLASS_ID, classVersion: '1.0.0', providerKinds: ['recipe'],
    })).toMatchObject({ providerKind: 'recipe', boundBy: expect.stringMatching(/^cupboard:install-blueprint#/) });
    // D-037: the destination resolves the bundled package from the release that shipped it.
    expect(await resolveInstalledReleasePackage(INSTALLED_BLUEPRINTS_DIR(), { kind: 'recipe', ref: RECIPE, version: '1.0.0' }))
      .toMatchObject({ contentHash: recipePin.contentHash });
    // D-042: the bundled vocabulary is claimed for this workspace, attributed to the install.
    expect(await registeredKey()).toMatchObject({ status: 'active', contributor: `cupboard:blueprint:${ID}`,
      keyPattern: `${EVENT_KEY}:*`, tags: ['acme'] });
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
    expect(packageInputs(launch)).toEqual(expect.arrayContaining([`recipe:${RECIPE}#${recipePin.contentHash}`,
      `knowledge-pack:${PACK}#${packPin.contentHash}`]));

    // Launch: the wearer's journal makes the vendored recipe callable and delivers the pack's memory and doc.
    expect(await recipeResult()).toMatchObject({ ok: false, error: 'not_found' });
    expect(await packMemories()).toEqual([]);
    await wear('p020-launcher', launch);
    expect(await recipeResult()).toMatchObject({
      ok: true, id: RECIPE, recipe: { script: 'return tools.notes.read({});', authorRole: 'blueprint-bundle' },
    });
    expect(await packMemories()).toEqual([expect.stringContaining(MEMORY_TEXT)]);
    expect(await packDocs()).toEqual([{ part_key: DOC_PART, body: `**Review steps**\n\n${DOC_BODY}`,
      author: expect.stringMatching(/^blueprint-package-resource:/) }]);
    const launcherDocs = await resolveWearerPackageDocKeys(db.adminSql, { workspaceId: WS, ownerId: 'p020-launcher' });
    expect(launcherDocs).toHaveLength(1);

    // Mid-session attach: the same compile delivers the same memory and doc, shared rather than duplicated.
    const attach = await compile();
    expect(attach.specificationRevision).toBe(launch.specificationRevision);
    expect(packageInputs(attach)).toEqual(packageInputs(launch));
    await wear('p020-wearer', attach);
    expect(await resolveWearerPackageDocKeys(db.adminSql, { workspaceId: WS, ownerId: 'p020-wearer' })).toEqual(launcherDocs);
    expect(await packMemories()).toHaveLength(1);
    expect((await packDocs()).map((row) => row.part_key)).toEqual([DOC_PART]);
    const holders = await db.adminSql<Array<{ resource_kind: string; wearers: number }>>`
      SELECT r.resource_kind, count(*)::int AS wearers FROM harness_shared.blueprint_package_dependents d
        JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
       WHERE d.workspace_id = ${WS} AND d.dependent_id LIKE 'session-package:%' AND d.phase = 'applied'
       GROUP BY r.resource_key, r.resource_kind ORDER BY r.resource_kind`;
    expect(holders).toEqual([{ resource_kind: 'code-recipe', wearers: 2 }, { resource_kind: 'doc-part', wearers: 2 },
      { resource_kind: 'memory', wearers: 2 }]);

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

    // The async hook: each wearer holds one live subscription on the claimed key,
    // and one fire plans exactly one wearer-principal reaction per wearer.
    const subscribers = await keySubscribers();
    expect(subscribers).toEqual(['p020-launcher', 'p020-wearer'].map((ownerId) => ({
      subscriber_id: expect.any(String), delivery_mode: IDENTITY_RULE_DELIVERY_MODE,
      derived_from_kind: IDENTITY_RULE_SUBSCRIPTION_KIND, derived_from_ref: ownerId })));
    const planned = planIdentityReactions({ workspaceId: WS, eventKey: EVENT_KEY, fireId: `${EVENT_KEY}@1#1`,
      payload: { change: 'c-1' }, rows: subscribers });
    expect(planned.unparseable).toEqual([]);
    expect(planned.payloads.map((payload) => payload.ownerId)).toEqual(['p020-launcher', 'p020-wearer']);
    expect(new Set(planned.payloads.map((payload) => payload.pinRef)).size).toBe(1);
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

  it('refuses a signed release whose async hook listens on a key nothing catalogues, before consent or activation', async () => {
    const lifecycleBefore = await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID);
    await writeAsyncRule(`${PUBLISHER}:never-catalogued`);
    try {
      const published = await publish();
      const unlisted = {
        decision: 'approved' as const, artifactContentHash: published.manifest.rootHash,
        contracts: published.source.archive.classContracts.map((entry) => ({ ref: entry.ref, contractHash: entry.contractHash })),
      };
      await expect(installBlueprintFromCupboardCore({
        githubUrl: `https://github.com/${PUBLISHER}/${ID}`, expectedRelease: { manifest: published.manifest.release },
        classContractConsent: unlisted,
        capabilityContext: { workspaceId: WS, potSlug: POT, mode: 'agent', recipeProviderConsent: recipeConsent },
      }, destinationDeps())).rejects.toMatchObject({ code: 'async_rule_not_installable',
        data: { refusals: [{ rule: ASYNC_RULE, error: expect.stringContaining(`${PUBLISHER}:never-catalogued`) }] } });
    } finally {
      await writeAsyncRule(EVENT_KEY);
    }
    expect(await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).toEqual(lifecycleBefore);
    expect(await getEventKey(db.adminSql, WS, `${PUBLISHER}:never-catalogued`)).toBeNull();
  }, 120_000);

  it('uninstalls and rolls back through the pot journal, and releases shared resources without damaging retained ones', async () => {
    const lifecycle = (operation: 'uninstall' | 'rollback') =>
      blueprintInstallJournal({ sql: db.adminSql, workspaceId: WS, blueprintId: ID }, { operation });
    const potBinding = () => getPotCapabilityProviderBinding(db.adminSql, {
      workspaceId: WS, potSlug: POT, classId: CLASS_ID, classVersion: '1.0.0', providerKinds: ['recipe'],
    });

    // Rollback to the retained release re-converges exactly the binding its install recorded.
    const rolled = await rollbackBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), id: ID, target: '1.0.0',
      journal: lifecycle('rollback') });
    expect(rolled.journal?.pots).toMatchObject([{ potSlug: POT, bindings: [`${CLASS_REF} → ${ID}@1.0.0`] }]);
    expect(rolled.journal?.residue).toEqual([]);
    expect(await potBinding()).toMatchObject({ providerKind: 'recipe', boundBy: expect.stringMatching(/^cupboard:install-blueprint#/) });
    expect((await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).active?.version).toBe('1.0.0');

    // Uninstall: the file tier and the install's own pot binding go; the destination's
    // imported contract and its conformance proof are its own, and stay.
    const removed = await uninstallBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), id: ID, journal: lifecycle('uninstall') });
    expect(removed.journal).toMatchObject({ residue: [], pots: [{ potSlug: POT }] });
    expect(await potBinding()).toBeNull();
    expect((await readBlueprintLifecycle(INSTALLED_BLUEPRINTS_DIR(), ID)).active).toBeNull();
    expect(await getCapabilityClass(db.adminSql, WS, CLASS_ID, '1.0.0')).toMatchObject({ id: CLASS_ID });
    const [proof] = await db.adminSql`SELECT status FROM harness_shared.capability_class_provider_bindings
      WHERE workspace_id = ${WS} AND class_id = ${CLASS_ID} AND provider_package = ${ID}`;
    expect(proof).toEqual({ status: 'active' });
    // D-042: the key only this release claimed is released with it; wearers' rows now fire nothing.
    expect(await registeredKey()).toBeNull();

    // Wearers release the shared resources. The destination edits the delivered doc first.
    const edited = 'Our own review steps, edited after install.';
    await db.adminSql`UPDATE harness_shared.harness_doc_parts SET body = ${edited}
      WHERE workspace_id = ${WS} AND part_key = ${DOC_PART}`;
    const detached = await compileLaunchSpecificationArtifact({
      promptText: 'Review the change.', cwd: root, workspaceId: WS, harnessSlug: POT,
      role: 'worker', stack: [], state: { schemaVersion: 1 }, renderStack: true,
    });
    await wear('p020-wearer', detached);
    // One wearer still holds everything: nothing is removed.
    expect(await recipeResult()).toMatchObject({ ok: true, id: RECIPE });
    expect(await packMemories()).toHaveLength(1);
    expect(await resolveWearerPackageDocKeys(db.adminSql, { workspaceId: WS, ownerId: 'p020-wearer' })).toEqual([]);

    // The last wearer releases: pristine content is removed, the edited doc is re-owned and kept.
    await wear('p020-launcher', detached);
    expect(await recipeResult()).toMatchObject({ ok: false, error: 'not_found' });
    expect(await packMemories()).toEqual([]);
    expect(await packDocs()).toEqual([{ part_key: DOC_PART, body: edited, author: PACKAGE_DOC_USER_OWNED }]);
    expect(await keySubscribers()).toEqual([]);
    expect(await db.adminSql`SELECT phase FROM harness_shared.blueprint_package_installations
      WHERE workspace_id = ${WS} AND dependent_id LIKE 'session-package:%' AND phase NOT IN ('released')`).toEqual([]);
  }, 180_000);
});
