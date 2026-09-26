export interface PortalReconcileConfig {
  portalRoot: string;
  runtimeRoot: string;
  integrationRoot: string;
  deployScript: string;
  npm: string;
  port: number;
  env: Record<string, string>;
}

export function reconcilePortal(
  config: PortalReconcileConfig,
  deps?: object,
): Promise<{ status: 'fresh' | 'recovered' | 'deployed'; releasePath: string }>;
