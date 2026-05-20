/**
 * Route registry barrel.
 *
 * Every `defineRoute` module is side-effect-free and `export default`s
 * either one `RouteDefinition` or an array of them (a route file that
 * serves multiple methods on one path — e.g. GET + OPTIONS). This barrel
 * imports them all and flattens into `ALL_ROUTES`.
 *
 * Add a route: drop a file under `routes/<family>/<name>.ts`, then add a
 * line here. Mirrors the `lib/agent-tools/index.ts` barrel pattern.
 *
 * R1 — 3 pilots. R4/R5 grow this to all 243 endpoints.
 */
import type { ZodTypeAny } from 'zod';
import type { RouteDefinition } from '../define-route';

import desktopVersion from './desktop/version';
import operatorDismissed from './agent-mcp/operator-dismissed';
import flagsWebhook from './flags/webhook';
import flagsBootstrap from './flags/bootstrap';
import flagsStream from './flags/stream';
import flagsSet from './flags/set';
import flagsTestingFeatures from './flags/testing-features';
import flagsPreset from './flags/preset';
import flagsDashboardUrl from './flags/dashboard-url';
import devRouteInvocations from './dev/route-invocations';
import agentConfig from './agent-config/index';
import agentConfigTest from './agent-config/test';
import credentials from './credentials/index';
import credentialsSearchProviders from './credentials/search-providers';
import agentTokensPowerUser from './agent-tokens/power-user';
import agentTokensPowerUserRefresh from './agent-tokens/power-user-refresh';
import installed from './installed/index';
import installedPrune from './installed/prune';
import oauthStart from './oauth/start';
import oauthCallback from './oauth/callback';
import oauthVerifyPaste from './oauth/verify-paste';
import publishCredentials from './publish-credentials/index';
import publishCredentialsRotate from './publish-credentials/rotate';
import miscRuntimeConfig from './misc/runtime-config';
import miscToastLog from './misc/toast-log';
import miscWikiBacklinks from './misc/wiki-backlinks';
import miscProfile from './misc/profile';
import miscSecurityAdvisoriesCheck from './misc/security-advisories-check';
import miscAgentBundle from './misc/agent-bundle';
import miscTestButtonsEcho from './misc/test-buttons-echo';
import miscUpdatesManifest from './misc/updates-manifest';
import authLogin from './auth/login';
import authLogout from './auth/logout';
import authSignup from './auth/signup';
import authChangePassword from './auth/change-password';
import authMe from './auth/me';
import provisionConsent from './provision/consent';
import provisionHostCheck from './provision/host-check';
import provisionState from './provision/state';
import provisionRun from './provision/run';
import provisionStream from './provision/stream';
import desktopAgentAuthStatus from './desktop/agent-auth-status';
import desktopAgentLoginEnvelope from './desktop/agent-login-envelope';
import desktopGitIdentity from './desktop/git-identity';
import desktopPreflight from './desktop/preflight';
import desktopSetupPtyCommands from './desktop/setup-pty-commands';
import desktopSetupStatus from './desktop/setup-status';
import desktopSetupWizardState from './desktop/setup-wizard-state';
import desktopTelemetryConfig from './desktop/telemetry-config';
import desktopTelemetryFlush from './desktop/telemetry-flush';
import desktopTelemetryReport from './desktop/telemetry-report';
import desktopVoiceConfigured from './desktop/voice-configured';
import desktopWorkspaceValidate from './desktop/workspace-validate';
import adminBackupOrphanCleanup from './admin/backup-orphan-cleanup';
import adminCommands from './admin/commands';
import adminEmbedBackfill from './admin/embed-backfill';
import adminExecuteAction from './admin/execute-action';
import adminLlmTestsFindings from './admin/llm-tests-findings';
import adminLlmTestsFindingById from './admin/llm-tests-finding-by-id';
import adminLlmTestsRuns from './admin/llm-tests-runs';
import adminLlmTestsRunById from './admin/llm-tests-run-by-id';
import adminLlmTestsScenarios from './admin/llm-tests-scenarios';
import adminPruneExecutedActions from './admin/prune-executed-actions';
import adminRotateToken from './admin/rotate-token';
import adminRun from './admin/run';
import adminSpawnSigningFailures from './admin/spawn-signing-failures';
import adminSpawnSigningRotate from './admin/spawn-signing-rotate';
import adminTables from './admin/tables';
import adminTablesByName from './admin/tables-by-name';
import adminTestingAiExplore from './admin/testing-ai-explore';
import workspaces from './workspaces/index';
import workspaceById from './workspaces/by-id';
import workspaceSwitch from './workspaces/switch';
import userActionsBySlug from './user-actions/by-slug';
import userActionsLog from './user-actions/log';
import elevenlabsWebhook from './elevenlabs/webhook';
import elevenlabsPostCall from './elevenlabs/post-call';
import miscScratch from './misc/scratch';
import mobileQrSvg from './mobile/qr-svg';
import designFeatures from './design/features';
import designRegressions from './design/regressions';
import designRegressionFile from './design/regression-file';
import designSketches from './design/sketches';
import userPreferences from './user/preferences';
import userSearch from './user/search';
import userMemory from './user/memory';
import userMemoryFeedback from './user/memory-feedback';
import userMemoryReembed from './user/memory-reembed';
import devSql from './dev/sql';
import devProcessesKill from './dev/processes-kill';
import devTables from './dev/tables';
import devTableSchema from './dev/table-schema';
import devTableRows from './dev/table-rows';
import devDrizzleStudio from './dev/drizzle-studio';
import templatesIndex from './templates/index';
import templatesVersion from './templates/version';
import templatesFile from './templates/file';
import templatesInstall from './templates/install';
import templatesPublish from './templates/publish';
import marketplaceCatalog from './marketplace/catalog';
import marketplaceSlug from './marketplace/slug';
import marketplaceInstall from './marketplace/install';
import marketplaceInstallPlugin from './marketplace/install-plugin';
import marketplaceUninstall from './marketplace/uninstall';
import marketplaceSpawnable from './marketplace/spawnable';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function flatten(entry: AnyRoute | AnyRoute[]): AnyRoute[] {
  return Array.isArray(entry) ? entry : [entry];
}

/** Every registered route, flattened. The order here is the mount order. */
export const ALL_ROUTES: ReadonlyArray<AnyRoute> = [
  ...flatten(desktopVersion as AnyRoute | AnyRoute[]),
  ...flatten(operatorDismissed as AnyRoute),
  ...flatten(flagsWebhook as AnyRoute),
  ...flatten(flagsBootstrap as AnyRoute),
  ...flatten(flagsStream as AnyRoute),
  ...flatten(flagsSet as AnyRoute),
  ...flatten(flagsTestingFeatures as AnyRoute[]),
  ...flatten(flagsPreset as AnyRoute),
  ...flatten(flagsDashboardUrl as AnyRoute),
  ...flatten(devRouteInvocations as AnyRoute),
  ...flatten(agentConfig as AnyRoute[]),
  ...flatten(agentConfigTest as AnyRoute),
  ...flatten(credentials as AnyRoute[]),
  ...flatten(credentialsSearchProviders as AnyRoute[]),
  ...flatten(agentTokensPowerUser as AnyRoute),
  ...flatten(agentTokensPowerUserRefresh as AnyRoute),
  ...flatten(installed as AnyRoute),
  ...flatten(installedPrune as AnyRoute),
  ...flatten(oauthStart as AnyRoute),
  ...flatten(oauthCallback as AnyRoute),
  ...flatten(oauthVerifyPaste as AnyRoute),
  ...flatten(publishCredentials as AnyRoute[]),
  ...flatten(publishCredentialsRotate as AnyRoute),
  ...flatten(miscRuntimeConfig as AnyRoute),
  ...flatten(miscToastLog as AnyRoute[]),
  ...flatten(miscWikiBacklinks as AnyRoute),
  ...flatten(miscProfile as AnyRoute[]),
  ...flatten(miscSecurityAdvisoriesCheck as AnyRoute),
  ...flatten(miscAgentBundle as AnyRoute),
  ...flatten(miscTestButtonsEcho as AnyRoute),
  ...flatten(miscUpdatesManifest as AnyRoute),
  ...flatten(authLogin as AnyRoute),
  ...flatten(authLogout as AnyRoute),
  ...flatten(authSignup as AnyRoute),
  ...flatten(authChangePassword as AnyRoute),
  ...flatten(authMe as AnyRoute[]),
  ...flatten(provisionConsent as AnyRoute[]),
  ...flatten(provisionHostCheck as AnyRoute[]),
  ...flatten(provisionState as AnyRoute),
  ...flatten(provisionRun as AnyRoute),
  ...flatten(provisionStream as AnyRoute),
  ...flatten(desktopAgentAuthStatus as AnyRoute),
  ...flatten(desktopAgentLoginEnvelope as AnyRoute),
  ...flatten(desktopGitIdentity as AnyRoute),
  ...flatten(desktopPreflight as AnyRoute[]),
  ...flatten(desktopSetupPtyCommands as AnyRoute),
  ...flatten(desktopSetupStatus as AnyRoute),
  ...flatten(desktopSetupWizardState as AnyRoute[]),
  ...flatten(desktopTelemetryConfig as AnyRoute),
  ...flatten(desktopTelemetryFlush as AnyRoute),
  ...flatten(desktopTelemetryReport as AnyRoute[]),
  ...flatten(desktopVoiceConfigured as AnyRoute),
  ...flatten(desktopWorkspaceValidate as AnyRoute),
  ...flatten(adminBackupOrphanCleanup as AnyRoute),
  ...flatten(adminCommands as AnyRoute),
  ...flatten(adminEmbedBackfill as AnyRoute),
  ...flatten(adminExecuteAction as AnyRoute),
  ...flatten(adminLlmTestsFindings as AnyRoute),
  ...flatten(adminLlmTestsFindingById as AnyRoute),
  ...flatten(adminLlmTestsRuns as AnyRoute),
  ...flatten(adminLlmTestsRunById as AnyRoute),
  ...flatten(adminLlmTestsScenarios as AnyRoute),
  ...flatten(adminPruneExecutedActions as AnyRoute),
  ...flatten(adminRotateToken as AnyRoute),
  ...flatten(adminRun as AnyRoute),
  ...flatten(adminSpawnSigningFailures as AnyRoute),
  ...flatten(adminSpawnSigningRotate as AnyRoute),
  ...flatten(adminTables as AnyRoute),
  ...flatten(adminTablesByName as AnyRoute[]),
  ...flatten(adminTestingAiExplore as AnyRoute),
  ...flatten(workspaces as AnyRoute[]),
  ...flatten(workspaceById as AnyRoute[]),
  ...flatten(workspaceSwitch as AnyRoute),
  ...flatten(userActionsBySlug as AnyRoute),
  ...flatten(userActionsLog as AnyRoute),
  ...flatten(elevenlabsWebhook as AnyRoute),
  ...flatten(elevenlabsPostCall as AnyRoute),
  ...flatten(miscScratch as AnyRoute),
  ...flatten(mobileQrSvg as AnyRoute),
  ...flatten(designFeatures as AnyRoute),
  ...flatten(designRegressions as AnyRoute),
  ...flatten(designRegressionFile as AnyRoute),
  ...flatten(designSketches as AnyRoute[]),
  ...flatten(userPreferences as AnyRoute[]),
  ...flatten(userSearch as AnyRoute),
  ...flatten(userMemory as AnyRoute[]),
  ...flatten(userMemoryFeedback as AnyRoute),
  ...flatten(userMemoryReembed as AnyRoute),
  ...flatten(devSql as AnyRoute),
  ...flatten(devProcessesKill as AnyRoute),
  ...flatten(devTables as AnyRoute),
  ...flatten(devTableSchema as AnyRoute),
  ...flatten(devTableRows as AnyRoute),
  ...flatten(devDrizzleStudio as AnyRoute[]),
  ...flatten(templatesIndex as AnyRoute),
  ...flatten(templatesVersion as AnyRoute[]),
  ...flatten(templatesFile as AnyRoute[]),
  ...flatten(templatesInstall as AnyRoute),
  ...flatten(templatesPublish as AnyRoute),
  ...flatten(marketplaceCatalog as AnyRoute),
  ...flatten(marketplaceSlug as AnyRoute),
  ...flatten(marketplaceInstall as AnyRoute[]),
  ...flatten(marketplaceInstallPlugin as AnyRoute),
  ...flatten(marketplaceUninstall as AnyRoute),
  ...flatten(marketplaceSpawnable as AnyRoute),
];
