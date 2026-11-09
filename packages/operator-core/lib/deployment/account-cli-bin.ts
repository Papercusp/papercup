/** Binary selection shared by login and read-only installed-state discovery. */
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolveAgentBinarySync } from '../agent-bin-detect';
import { WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN } from '@papercusp/deployment-driver';
import type { AccountProvider } from './account-pool';

/** Preserve login's explicit override, vendor-toolchain and stripped-PATH rules. */
export function resolveCliBin(
  provider: AccountProvider,
  env: NodeJS.ProcessEnv = process.env,
  sharedResolver: (bin: string) => string | null = resolveAgentBinarySync,
): string {
  const name = provider === 'codex' ? 'codex' : 'claude';
  const override = provider === 'codex' ? env.CODEX_BIN : env.CLAUDE_BIN;
  if (override) return override;
  if (env.PAPERCUSP_DISTRIBUTION_PROFILE === 'vm-release') {
    const vendor = `${WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN}/${name}`;
    try {
      accessSync(vendor, constants.X_OK);
      return vendor;
    } catch {
      throw new Error(`the ${provider === 'codex' ? 'Codex' : 'Claude'} vendor login CLI is missing from the customer agent toolchain (${vendor}) — repair or upgrade the workspace host`);
    }
  }
  const home = homedir();
  const candidates = [
    ...(env.PATH ?? '').split(':').filter(Boolean).map(d => `${d}/${name}`),
    `${home}/.local/bin/${name}`,
    `${home}/.claude/local/${name}`,
    `${home}/.bun/bin/${name}`,
    `${home}/.npm-global/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/home/linuxbrew/.linuxbrew/bin/${name}`,
  ];
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; }
    catch { /* Try the next installed location. */ }
  }
  return sharedResolver(name) || name;
}
