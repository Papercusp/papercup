import type { ReactNode } from 'react';

interface NavLink {
  href: string;
  label: string;
  external?: boolean;
}

interface Props {
  navLinks?: NavLink[];
  extras?: ReactNode;
  quote?: string;
  /**
   * Centre-of-bar prominent CTA. Defaults to "Mission Control" pointing
   * at the operator. Pass `null` to suppress (e.g. on the operator
   * itself, where the user is already there).
   */
  cta?: { href: string; label: string } | null;
}

const DEFAULT_NAV: NavLink[] = [
  { href: '/marketplace/', label: 'Marketplace' },
  { href: '/docs', label: 'Docs' },
  { href: '/support', label: 'Support' },
  { href: 'https://github.com/papercupai/papercusp', label: 'GitHub', external: true },
];

const DEFAULT_QUOTE = 'Nothing is so painful to the human mind as a great and sudden change';
const DEFAULT_CTA = { href: 'http://localhost:3055/harness', label: 'Mission Control' };

export function SiteHeader({
  navLinks = DEFAULT_NAV,
  extras,
  quote = DEFAULT_QUOTE,
  cta,
}: Props = {}) {
  const resolvedCta = cta === undefined ? DEFAULT_CTA : cta;
  return (
    <header className="pc-header">
      <a href="/" className="brand" aria-label="papercusp" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <img src="/mascot.svg" alt="" width={28} height={28} style={{ display: 'block' }} />
        <img src="/wordmark.svg" alt="papercusp" height={22} style={{ display: 'block' }} />
      </a>
      <span className="pc-header-quote">{quote}</span>
      {resolvedCta ? (
        <a
          href={resolvedCta.href}
          className="pc-header-cta"
          aria-label={resolvedCta.label}
        >
          {resolvedCta.label}
        </a>
      ) : null}
      <nav aria-label="Primary navigation">
        {navLinks.map((l) => (
          <a
            key={l.href}
            href={l.href}
            {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {l.label}
          </a>
        ))}
        {extras}
      </nav>
    </header>
  );
}
