import { source } from '@/lib/source';
import { fumadocsAdapter, withPreamble } from '@papercusp/docs-engine';
import { notFound } from 'next/navigation';

const adapter = fumadocsAdapter(source as never, { name: 'papercusp-public' });

export const revalidate = 300;

export async function GET(_: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = await adapter.getPage((slug ?? []).join('/'));
  if (!page) notFound();
  const body = await adapter.getContent(page);
  const text = withPreamble(body, {
    title: page.title,
    url: page.url,
    ...(page.description ? { description: page.description } : {}),
  });
  return new Response(text, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}
