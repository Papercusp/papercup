'use client';

import { useState } from 'react';

interface GalleryTab {
  id: string;
  label: string;
  description: string;
  images: Array<{
    src: string;
    alt: string;
    caption?: string;
  }>;
}

interface FeatureShowcaseProps {
  tabs?: GalleryTab[];
}

const defaultTabs: GalleryTab[] = [
  {
    id: 'self-improvement',
    label: 'Self-improvement',
    description: 'Autonomous agents continuously improving their own systems',
    images: [],
  },
  {
    id: 'plan-ship',
    label: 'Plan & ship',
    description: 'Collaborative planning and deployment pipeline',
    images: [],
  },
  {
    id: 'fleet-coordination',
    label: 'Fleet & coordination',
    description: 'Multi-agent fleet coordination and task management',
    images: [],
  },
  {
    id: 'operate',
    label: 'Operate',
    description: 'System operation and monitoring',
    images: [],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    description: 'Knowledge management and recall systems',
    images: [],
  },
  {
    id: 'extend',
    label: 'Extend it',
    description: 'Extensibility and customization',
    images: [],
  },
  {
    id: 'federation',
    label: 'Federation',
    description: 'Cross-system federation and integration',
    images: [],
  },
];

export function FeatureShowcase({ tabs = defaultTabs }: FeatureShowcaseProps) {
  const [activeTab, setActiveTab] = useState(tabs[0]?.id || 'self-improvement');
  const currentTab = tabs.find((t) => t.id === activeTab) || tabs[0];

  return (
    <section id="showcase" className="band showcase-band">
      <div className="showcase-header">
        <p className="section-kicker">See it in action</p>
        <h2>Feature Showcase</h2>
        <p className="showcase-intro">
          Explore the Papercusp system across different workflows and capabilities.
        </p>
      </div>

      <div className="showcase-container">
        {/* Tab Navigation */}
        <nav className="showcase-tabs" aria-label="Feature showcase tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`showcase-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Tab Content */}
        {currentTab && (
          <div id={`panel-${currentTab.id}`} className="showcase-panel" role="tabpanel">
            <div className="showcase-panel-header">
              <h3>{currentTab.label}</h3>
              <p>{currentTab.description}</p>
            </div>

            {currentTab.images.length > 0 ? (
              <div className="showcase-gallery">
                {currentTab.images.map((image, idx) => (
                  <figure key={idx} className="showcase-image">
                    <img src={image.src} alt={image.alt} loading="lazy" />
                    {image.caption && <figcaption>{image.caption}</figcaption>}
                  </figure>
                ))}
              </div>
            ) : (
              <div className="showcase-placeholder">
                <p>Gallery images for this section coming soon.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default FeatureShowcase;
