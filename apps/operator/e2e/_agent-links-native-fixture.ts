import type { ReportBlock } from '@papercusp/chat-protocol';

/** Persist the curator report shape the conversation provider displays. */
export function nativeAgentLinksReportFixture(href: string) {
  return {
    source: 'system' as const,
    report: {
      title: 'Agent links report lines',
      plans: [{ title: 'Native reference check', status: 'active',
        items: [{ id: 'P-001', text: `Report card route ${href}`, status: 'done' }] }],
    } satisfies ReportBlock,
  };
}

/** The journey opens chat=true; only that current state may supplement its target.
 * Keep this Node fixture independent of browser-module loader conventions. */
export function nativeAgentLinkSelectorExpression(scope: string, href: string): string {
  return `(() => {
    const scope = ${JSON.stringify(scope)};
    const current = new URL(location.href);
    const expected = new URL(${JSON.stringify(href)}, current);
    if (expected.origin !== current.origin) throw new Error('Expected an in-app reference');
    const chatKey = 'chat';
    const canonicalSearch = params => { const copy = new URLSearchParams(params); copy.sort(); return copy.toString(); };
    const roots = document.querySelectorAll(scope);
    if (roots.length > 1) throw new Error('Ambiguous native reference scope');
    if (roots.length === 0) return null;
    const root = roots[0];
    const matches = Array.from(root.querySelectorAll('a[href]')).filter(anchor => {
      const actual = new URL(anchor.getAttribute('href'), current);
      if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || actual.hash !== expected.hash) return false;
      if (!expected.searchParams.has(chatKey) && actual.searchParams.has(chatKey)) {
        if (JSON.stringify(actual.searchParams.getAll(chatKey)) !== JSON.stringify(current.searchParams.getAll(chatKey))) return false;
        actual.searchParams.delete(chatKey);
      }
      return canonicalSearch(actual.searchParams) === canonicalSearch(expected.searchParams);
    });
    if (matches.length > 1) throw new Error('Ambiguous native reference: ' + matches.length + ' anchors');
    if (matches.length === 0) return null;
    const path = [];
    for (let element = matches[0]; element !== root; element = element.parentElement) {
      path.unshift(element.localName + ':nth-child(' + (Array.from(element.parentElement.children).indexOf(element) + 1) + ')');
    }
    return scope + ' > ' + path.join(' > ');
  })()`;
}
