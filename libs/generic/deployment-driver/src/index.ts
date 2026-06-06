/**
 * @papercusp/deployment-driver — provider-agnostic harness/Hive deployment.
 *
 * See `./types` for the model. The cloud-deployment plan
 * (`cloud-deployment-layer-2026-06-06`) is the consumer.
 */
export type {
  DeploymentTarget,
  DeploymentPlacement,
  FrameKind,
  DeploymentConfig,
  Frame,
  LogLevel,
  DeploymentContext,
  DeploymentDriver,
} from './types';
export { LOCAL_DEPLOYMENT } from './types';
export { LocalDriver, LOCAL_FRAME } from './local-driver';
export {
  registerDeploymentDriver,
  configureDeployment,
  resolveDeploymentDriver,
  registeredDeploymentTargets,
  isLocalDeployment,
  _resetDeploymentDriversForTests,
} from './registry';
