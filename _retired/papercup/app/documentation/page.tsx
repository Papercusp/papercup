import { DocumentationFrame } from '@papercusp/papercusp-shared';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Documentation — Papercup',
  description: 'Harness reference: how it works, decisions, framework comparisons.',
};

export default function DocumentationPage() {
  const docsBase = process.env.NEXT_PUBLIC_PAPERCUP_DOCS_URL ?? 'https://docs.papercupai.com';
  return <DocumentationFrame src={docsBase} />;
}
