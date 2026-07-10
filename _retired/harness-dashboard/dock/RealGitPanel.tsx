/**
 * RealGitPanel — wraps the existing GitGraphPanel from @papercusp/git-graph
 * for use inside a dock panel.
 *
 * The library component already handles fetch + virtualization + commit
 * detail drawer; we just provide the URL builders + scope.
 */

'use client';

import dynamic from '@/lib/router-compat/dynamic';
import type { PanelComponentProps } from './panel-registry';
import { crossOriginUrl } from '@papercusp/operator-core/lib/cross-origin-url';

const GitGraphPanelLib = dynamic(
  () => import('@papercusp/git-graph').then((m) => ({ default: m.GitGraphPanel })),
  { ssr: false, loading: () => (
    <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
      Loading git graph…
    </div>
  ) },
);

export function RealGitPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  if (!slug) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params.
      </div>
    );
  }
  return (
    <GitGraphPanelLib
      scope={`harness:${slug}`}
      gitLogUrl={(limit: number) => `/api/harness/${slug}/git/log?limit=${limit}`}
      showCommitUrl={(sha: string) => crossOriginUrl(`/api/harness/${slug}/git/show/${sha}`)}
      worktreesUrl={() => `/api/harness/${slug}/git/worktrees`}
      onCommitHref={(sha: string) => `/harness/${slug}/commit/${sha}`}
    />
  );
}
