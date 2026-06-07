const tagline =
  'Welcome to the End. Be part of the new beginning. Create or Join a Hive, start a swarm, and mold the future for whatever comes next.';

const lexicon = [
  ['Hive', 'The top-level project you create or join.'],
  ['Swarm', 'The live set of bees working inside a Hive.'],
  ['Queen', 'The brain that thinks, judges, and coordinates.'],
  ['Sentinel Bee', 'The always-on operator watching the perimeter.'],
  ['Keeper', 'A human who shapes and directs the Hive.'],
  ['Cell', 'One unit of work in the comb.'],
] as const;

const proofPoints = [
  'Many agents and humans working one shared honeycomb.',
  'A Queen brain for high-judgment coordination.',
  'Always-on Sentinel Bees that keep the system awake.',
  'Dark-first tooling built for real software work.',
] as const;

export default function Home() {
  return (
    <main>
      <section className="intro" aria-label={tagline}>
        <p className="intro-line intro-line-one">Welcome to the End.</p>
        <p className="intro-line intro-line-two">Be part of the new beginning.</p>
        <p className="intro-line intro-line-three">Create or Join a Hive, start a swarm.</p>
        <p className="intro-line intro-line-four">And mold the future for whatever comes next.</p>
        <div className="intro-swarm" aria-hidden="true">
          {Array.from({ length: 28 }, (_, index) => (
            <span key={index} style={{ '--bee-index': index } as React.CSSProperties} />
          ))}
        </div>
      </section>

      <div className="site-shell">
        <header className="site-header">
          <a className="brand" href="#top" aria-label="The Swarm home">
            <img src="/brand/primary-mark.svg" alt="" />
            <span>The Swarm</span>
          </a>
          <nav aria-label="Primary navigation">
            <a href="#hive">Hive</a>
            <a href="#queen">Queen</a>
            <a href="#lexicon">Lexicon</a>
          </nav>
        </header>

        <section id="top" className="hero">
          <img className="hero-image" src="/brand/swarm-hero.png" alt="" />
          <div className="hero-shade" aria-hidden="true" />
          <div className="hero-content">
            <img className="hero-mark" src="/brand/primary-mark.svg" alt="" />
            <h1>The Swarm</h1>
            <p className="tagline">{tagline}</p>
            <div className="hero-actions" aria-label="Primary actions">
              <a href="mailto:founders@theswarm.dev?subject=Join%20The%20Swarm">Request access</a>
              <a href="#hive">Enter the Hive</a>
            </div>
          </div>
        </section>

        <section id="hive" className="band hive-band">
          <div>
            <p className="section-kicker">Distributed work, directed by intent</p>
            <h2>Create or Join a Hive.</h2>
          </div>
          <div className="proof-grid">
            {proofPoints.map((point) => (
              <article key={point}>
                <span />
                <p>{point}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="queen" className="queen-band">
          <div className="queen-copy">
            <p className="section-kicker">The brain is awake</p>
            <h2>The Queen coordinates the swarm.</h2>
            <p>
              The operator watches. The Queen thinks. Keepers decide when to create a Hive,
              start a swarm, and let the colony change the shape of the work.
            </p>
          </div>
          <img src="/brand/queen-mark.svg" alt="The Queen mark" />
        </section>

        <section id="lexicon" className="band lexicon-band">
          <div>
            <p className="section-kicker">The language of the system</p>
            <h2>One comb. Many roles.</h2>
          </div>
          <div className="lexicon-grid">
            {lexicon.map(([term, meaning]) => (
              <article key={term}>
                <strong>{term}</strong>
                <p>{meaning}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
