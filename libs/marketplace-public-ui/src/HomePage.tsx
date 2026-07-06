import React from 'react';
import { Download, Eye, Layers, MonitorCog, Search } from 'lucide-react';

// Last-resort fallback used only when no desktopReleaseUrl prop is passed
// AND the consumer didn't fetch one from /api/operator/settings/desktop_release_url
// (canonical source — Migration 038). Consumers SHOULD pass the prop;
// this default exists so the page still renders something on a fresh install.
const DEFAULT_DESKTOP_RELEASE_URL = '#';

interface Props {
  desktopReleaseUrl?: string;
  marketplaceHref?: string;
}

export function HomePage({
  desktopReleaseUrl = DEFAULT_DESKTOP_RELEASE_URL,
  marketplaceHref = '/marketplace',
}: Props = {}) {
  const pillars = [
    {
      icon: MonitorCog,
      title: 'Runs on your machine',
      body: 'Your files, keys, and project state never leave the desktop app. Nothing is uploaded unless you publish it.',
    },
    {
      icon: Layers,
      title: 'Starts from a template',
      body: 'Install a ready-made AI workflow from the marketplace instead of wiring one up from scratch.',
    },
    {
      icon: Eye,
      title: 'Shows its work',
      body: 'Watch a small AI team plan, do the work, and check each other in real time. Step in whenever you want.',
    },
  ];

  return (
    <div className="pc-shell pc-home-v2">
      <section className="pc-home-v2-hero" aria-labelledby="home-title">
        <h1 id="home-title" className="pc-home-v2-logo">
          <img src="/wordmark.svg" alt="Papercusp" />
        </h1>
        <p className="pc-home-v2-tagline">
          Run AI workflows on your own machine. Pick a template, give it a goal, and watch a small AI team plan, do the work, and review each other.
        </p>
        <div className="pc-home-v2-actions" aria-label="Primary actions">
          <a href={desktopReleaseUrl} target="_blank" rel="noreferrer" className="pc-button primary pc-home-v2-cta">
            <Download size={16} aria-hidden /> Download desktop app
          </a>
          <a href={marketplaceHref} className="pc-button pc-home-v2-cta">
            <Search size={16} aria-hidden /> Browse marketplace
          </a>
        </div>
        <p className="pc-home-v2-subnote">
          macOS · Windows · Linux · Free &amp; open source
        </p>
      </section>

      <section className="pc-home-v2-pillars" aria-labelledby="home-pillars-title">
        <h2 id="home-pillars-title" className="pc-sr-only">What Papercusp gives you</h2>
        {pillars.map(({ icon: Icon, title, body }) => (
          <article key={title} className="pc-card pc-home-v2-pillar">
            <span className="pc-home-v2-pillar-icon" aria-hidden><Icon size={22} /></span>
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </section>

    </div>
  );
}
