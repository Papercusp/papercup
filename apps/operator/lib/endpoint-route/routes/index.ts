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
import snapshotsList from './snapshots/index';
import snapshotsCreate from './snapshots/create';
import snapshotsById from './snapshots/by-id';
import snapshotsShape from './snapshots/shape';
import snapshotsPublish from './snapshots/publish';
import snapshotsRetract from './snapshots/retract';
import snapshotsInstantiate from './snapshots/instantiate';
import operatorBudgetTiers from './operator/budget-tiers';
import operatorStateSnapshot from './operator/state-snapshot';
import operatorSettingsByKey from './operator/settings-by-key';
import operatorConversations from './operator/conversations';
import operatorConversationTurns from './operator/conversation-turns';
import operatorCardResponse from './operator/card-response';
import operatorSilenceNudge from './operator/silence-nudge';
import operatorRunCancel from './operator/run-cancel';
import operatorTurnAnswer from './operator/turn-answer';
import backupsIndex from './backups/index';
import backupsBrokenList from './backups/broken-list';
import backupsFailures from './backups/failures';
import backupsMaintenance from './backups/maintenance';
import backupsRollback from './backups/rollback';
import backupsServer from './backups/server';
import backupsVerify from './backups/verify';
import backupsDestination from './backups/destination';
import backupsEvents from './backups/events';
import backupsHealthcheck from './backups/healthcheck';
import backupsPromote from './backups/promote';
import backupsRestore from './backups/restore';
import backupsSnapshots from './backups/snapshots';
import harnessProjects from './harness/projects';
import harnessAllKpis from './harness/all-kpis';
import harnessSearch from './harness/search';
import harnessFile from './harness/file';
import harnessManifest from './harness/manifest';
import harnessIntelArtifacts from './harness/intel-artifacts';
import harnessIntelSpawnTree from './harness/intel-spawn-tree';
import harnessBranchActions from './harness/branch-actions';
import harnessBranchActionRun from './harness/branch-action-run';
import harnessBranchActionStream from './harness/branch-action-stream';
import harnessBranchActionByNameRun from './harness/branch-action-by-name-run';
import harnessExpertRelatedDocs from './harness/expert-related-docs';
import harnessSaveAsTemplate from './harness/save-as-template';
import uiPresence from './ui/presence';
import uiIntentsStream from './ui/intents-stream';
import uiIntentResult from './ui/intent-result';
import zeroHarnessSse from './zero-harness/sse';
import zeroHarnessRestQuery from './zero-harness/rest-query';
import zeroHarnessRestQueryBatch from './zero-harness/rest-query-batch';
import miscZeroHarnessQuery from './misc/zero-harness-query';
import agentToolsCatchall from './agent-tools/catchall';
import pluginRuntimeCatchall from './plugin-runtime/catchall';
import transport from './transport/index';
import internalLogEvent from './internal/log-event';
import internalRunChunk from './internal/run-chunk';
import internalDecisionEvent from './internal/decision-event';
import internalEscalationEvent from './internal/escalation-event';
import internalArchiveEvent from './internal/archive-event';
import internalCheckpointEvent from './internal/checkpoint-event';
import internalFeatureDebugNoteEvent from './internal/feature-debug-note-event';
import internalHookLogEvent from './internal/hook-log-event';
import internalIdentitySnapshot from './internal/identity-snapshot';
import internalPlanReviewEvent from './internal/plan-review-event';
import internalPrEvent from './internal/pr-event';
import internalSkillSnapshot from './internal/skill-snapshot';
import internalSmokeTestEvent from './internal/smoke-test-event';
import internalTestSnapshot from './internal/test-snapshot';
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
  ...flatten(snapshotsList as AnyRoute),
  ...flatten(snapshotsCreate as AnyRoute),
  ...flatten(snapshotsById as AnyRoute[]),
  ...flatten(snapshotsShape as AnyRoute),
  ...flatten(snapshotsPublish as AnyRoute),
  ...flatten(snapshotsRetract as AnyRoute),
  ...flatten(snapshotsInstantiate as AnyRoute),
  ...flatten(operatorBudgetTiers as AnyRoute),
  ...flatten(operatorStateSnapshot as AnyRoute),
  ...flatten(operatorSettingsByKey as AnyRoute),
  ...flatten(operatorConversations as AnyRoute[]),
  ...flatten(operatorConversationTurns as AnyRoute[]),
  ...flatten(operatorCardResponse as AnyRoute),
  ...flatten(operatorSilenceNudge as AnyRoute),
  ...flatten(operatorRunCancel as AnyRoute),
  ...flatten(operatorTurnAnswer as AnyRoute),
  ...flatten(backupsIndex as AnyRoute[]),
  ...flatten(backupsBrokenList as AnyRoute),
  ...flatten(backupsFailures as AnyRoute),
  ...flatten(backupsMaintenance as AnyRoute),
  ...flatten(backupsRollback as AnyRoute),
  ...flatten(backupsServer as AnyRoute[]),
  ...flatten(backupsVerify as AnyRoute),
  ...flatten(backupsDestination as AnyRoute[]),
  ...flatten(backupsEvents as AnyRoute),
  ...flatten(backupsHealthcheck as AnyRoute),
  ...flatten(backupsPromote as AnyRoute),
  ...flatten(backupsRestore as AnyRoute),
  ...flatten(backupsSnapshots as AnyRoute[]),
  ...flatten(harnessProjects as AnyRoute),
  ...flatten(harnessAllKpis as AnyRoute),
  ...flatten(harnessSearch as AnyRoute),
  ...flatten(harnessFile as AnyRoute[]),
  ...flatten(harnessManifest as AnyRoute),
  ...flatten(harnessIntelArtifacts as AnyRoute),
  ...flatten(harnessIntelSpawnTree as AnyRoute),
  ...flatten(harnessBranchActions as AnyRoute),
  ...flatten(harnessBranchActionRun as AnyRoute),
  ...flatten(harnessBranchActionStream as AnyRoute),
  ...flatten(harnessBranchActionByNameRun as AnyRoute),
  ...flatten(harnessExpertRelatedDocs as AnyRoute),
  ...flatten(harnessSaveAsTemplate as AnyRoute),
  ...flatten(uiPresence as AnyRoute),
  ...flatten(uiIntentsStream as AnyRoute),
  ...flatten(uiIntentResult as AnyRoute),
  ...flatten(zeroHarnessSse as AnyRoute),
  ...flatten(zeroHarnessRestQuery as AnyRoute),
  ...flatten(zeroHarnessRestQueryBatch as AnyRoute),
  ...flatten(miscZeroHarnessQuery as AnyRoute),
  ...flatten(agentToolsCatchall as AnyRoute[]),
  ...flatten(pluginRuntimeCatchall as AnyRoute),
  ...flatten(internalLogEvent as AnyRoute),
  ...flatten(internalRunChunk as AnyRoute),
  ...flatten(internalDecisionEvent as AnyRoute),
  ...flatten(internalEscalationEvent as AnyRoute),
  ...flatten(internalArchiveEvent as AnyRoute),
  ...flatten(internalCheckpointEvent as AnyRoute),
  ...flatten(internalFeatureDebugNoteEvent as AnyRoute),
  ...flatten(internalHookLogEvent as AnyRoute),
  ...flatten(internalIdentitySnapshot as AnyRoute),
  ...flatten(internalPlanReviewEvent as AnyRoute),
  ...flatten(internalPrEvent as AnyRoute),
  ...flatten(internalSkillSnapshot as AnyRoute),
  ...flatten(internalSmokeTestEvent as AnyRoute),
  ...flatten(internalTestSnapshot as AnyRoute),
  // Transport last — single-segment :transport must not shadow literal paths.
  ...flatten(transport as AnyRoute[]),
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
