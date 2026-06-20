/*
 * Re-export of PluginTabs from libs/papercusp/apps/web/lib.
 * Exists because apps/papercup imports HarnessDashboard.tsx (in libs/papercusp)
 * which has `import PluginTabs from '@/lib/PluginTabs'` — and `@/` resolves
 * to apps/papercup root in this app's tsconfig, not to the libs/papercusp
 * source directory. Without this re-export, apps/papercup's prod build and
 * dev server fail to compile.
 *
 * Long-term fix: make HarnessDashboard.tsx use a workspace-aware import
 * (e.g. via a shared @papercusp/papercusp-shared export) instead of `@/`.
 */
import PluginTabs from '../../../libs/papercusp/apps/web/lib/PluginTabs';
export default PluginTabs;
