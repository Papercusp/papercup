/** Separate registry for durable workspace-host providers. */
import { pinModuleState } from '@papercusp/module-singleton';
import type { WorkspaceHostProvider, WorkspaceHostProviderConnection, WorkspaceHostProviderTarget } from './workspace-host-types';

const STATE_KEY = '@papercusp/deployment-driver:workspace-host-registry';
const state = pinModuleState<{ registry: Map<WorkspaceHostProviderTarget, WorkspaceHostProvider> }>(STATE_KEY, () => ({
  registry: new Map(),
}));

export function registerWorkspaceHostProvider(provider: WorkspaceHostProvider): void {
  state.registry.set(provider.target, provider);
}

export function configureWorkspaceHostProviders(options: { providers: readonly WorkspaceHostProvider[] }): void {
  for (const provider of options.providers) registerWorkspaceHostProvider(provider);
}

/** Resolve by open target or connection. There is intentionally no implicit local default. */
export function resolveWorkspaceHostProvider(
  selector: WorkspaceHostProviderTarget | Pick<WorkspaceHostProviderConnection, 'target'>,
): WorkspaceHostProvider {
  const target = typeof selector === 'string' ? selector : selector.target;
  const provider = state.registry.get(target);
  if (!provider) {
    throw new Error(
      `No workspace-host provider registered for target '${target}'. ` +
        `Registered: [${[...state.registry.keys()].join(', ')}]. ` +
        `A backend registers via configureWorkspaceHostProviders({ providers }) at host bootstrap.`,
    );
  }
  return provider;
}

export function registeredWorkspaceHostProviderTargets(): WorkspaceHostProviderTarget[] {
  return [...state.registry.keys()];
}

/** Test-only reset. Every real workspace host must select an explicit provider. */
export function _resetWorkspaceHostProvidersForTests(): void {
  state.registry.clear();
}
