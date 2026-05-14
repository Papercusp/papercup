import { internalSource as source } from '@/lib/source';
import { fumadocsAdapter, withPreamble } from '@papercusp/docs-engine';

const adapter = fumadocsAdapter(source as never, { name: 'papercusp-public' });

export const revalidate = 300;

export async function GET() {
  const pages = await adapter.listPages();
  const rendered = await Promise.all(
    pages.map(async (p) => {
      const body = await adapter.getContent(p);
      return withPreamble(body, {
        title: p.title,
        url: p.url,
        ...(p.description ? { description: p.description } : {}),
      });
    }),
  );
  return new Response(rendered.join('\n\n'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300',
    },
  });
}
