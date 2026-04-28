import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';

export default function PublicDocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: 'Papercup — Harness Docs' }}
    >
      {children}
    </DocsLayout>
  );
}
