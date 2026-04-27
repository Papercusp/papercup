import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { internalSource } from '@/lib/source';

export default function InternalDocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={internalSource.pageTree}
      nav={{ title: 'Papercusp Spec — Internal' }}
    >
      {children}
    </DocsLayout>
  );
}
