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

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

function flatten(entry: AnyRoute | AnyRoute[]): AnyRoute[] {
  return Array.isArray(entry) ? entry : [entry];
}

/** Every registered route, flattened. The order here is the mount order. */
export const ALL_ROUTES: ReadonlyArray<AnyRoute> = [
  ...flatten(desktopVersion as AnyRoute | AnyRoute[]),
  ...flatten(operatorDismissed as AnyRoute),
  ...flatten(flagsWebhook as AnyRoute),
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
];
