import { Layers, Package, Puzzle, Search } from 'lucide-react';

const categories = [
  {
    icon: Package,
    label: 'Templates',
    href: '/marketplace/templates',
    blurb: 'Complete workflows you install and run. Pick one to do a kind of job — write code, do research, run an org.',
    cta: 'Browse templates',
  },
  {
    icon: Puzzle,
    label: 'Plugins',
    href: '/marketplace/plugins',
    blurb: 'Optional add-ons. Plug them into a template to give it new abilities — publishing, integrations, dashboards.',
    cta: 'Browse plugins',
  },
  {
    icon: Layers,
    label: 'Snapshots',
    href: '/marketplace/snapshots',
    blurb: 'A frozen copy of a working setup. Fork one to start with someone else’s state instead of from scratch.',
    cta: 'Browse snapshots',
  },
];

export function MarketplaceIndex() {
  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-hero-v2" aria-labelledby="marketplace-title">
        <p className="pc-eyebrow">Marketplace</p>
        <h1 id="marketplace-title">Find a workflow. Run it on your machine.</h1>
        <p className="pc-marketplace-hero-tagline">
          A catalog of local AI workflows you can install, inspect, and run yourself. Nothing leaves your machine until you choose to publish.
        </p>

        <form
          action="/marketplace/templates"
          method="get"
          className="pc-marketplace-hero-search-v2"
          role="search"
          aria-label="Search the marketplace"
        >
          <Search size={18} aria-hidden />
          <input
            name="q"
            type="search"
            placeholder="What do you want Papercusp to do?"
            autoComplete="off"
            aria-label="Search templates"
          />
          <button type="submit" className="pc-button primary">Search</button>
        </form>

      </section>

      <section className="pc-marketplace-categories" aria-labelledby="marketplace-categories-title">
        <h2 id="marketplace-categories-title" className="pc-sr-only">Browse by category</h2>
        {categories.map(({ icon: Icon, label, href, blurb, cta }) => (
          <a key={label} href={href} className="pc-card pc-marketplace-category-card">
            <span className="pc-marketplace-category-icon" aria-hidden><Icon size={22} /></span>
            <h3>{label}</h3>
            <p>{blurb}</p>
            <b>{cta} →</b>
          </a>
        ))}
      </section>

      <section className="pc-marketplace-steps" aria-labelledby="marketplace-steps-title">
        <p className="pc-eyebrow">How it works</p>
        <h2 id="marketplace-steps-title">Three steps, all local.</h2>
        <ol>
          <li>
            <strong>1. Search</strong>
            <span>Type the kind of work you want — &ldquo;coding&rdquo;, &ldquo;research&rdquo;, &ldquo;publish to Cloudflare&rdquo;.</span>
          </li>
          <li>
            <strong>2. Review</strong>
            <span>Open a result. See what it installs, what it can access, who published it.</span>
          </li>
          <li>
            <strong>3. Install &amp; run</strong>
            <span>One click installs into your local operator. Watch it work in mission control.</span>
          </li>
        </ol>
        <p className="pc-marketplace-build-cta" style={{ marginTop: 16 }}>
          Want to publish your own?{' '}
          <a href="/docs/spec/plugin-quickstart" className="pc-link">
            Five-minute plugin quickstart →
          </a>
        </p>
      </section>
    </div>
  );
}
