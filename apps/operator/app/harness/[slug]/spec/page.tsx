/**
 * /harness/<slug>/spec[#anchor]
 *
 * Friendly URL that the operator's suggestion stream sometimes generates
 * (e.g. "Open SPEC.md — section 4.1"). The actual SpecEditor lives behind
 * the config panel's tab system — this page redirects there preserving the
 * hash so Vditor can jump to the heading anchor.
 */

import { redirect } from 'next/navigation';

export default async function HarnessSpecRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  // Browsers preserve `#anchor` across 307/308 redirects, so the section
  // hint in the original URL is carried through to the config panel where
  // Vditor's anchor scrolling kicks in for any matching heading id.
  redirect(`/harness/${encodeURIComponent(slug)}?panel=config&specTab=spec`);
}
