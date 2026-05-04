const cards = Array.from({ length: 6 }, (_, index) => index);

export default function MarketplaceLoading() {
  return (
    <div className="pc-shell pc-marketplace-shell" aria-busy="true">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow">Marketplace</p>
          <h1>Loading marketplace…</h1>
        </div>
      </section>
      <div className="pc-marketplace-grid">
        {cards.map((card) => (
          <article key={card} className="pc-card pc-marketplace-card">
            <div className="pc-marketplace-card-head">
              <span className="pc-marketplace-card-icon template" />
              <div>
                <strong className="pc-marketplace-card-title">Loading…</strong>
                <span>Fetching package details</span>
              </div>
            </div>
            <p>Preparing catalog entry…</p>
          </article>
        ))}
      </div>
    </div>
  );
}
