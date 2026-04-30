import ApiKeyStatus from './_components/ApiKeyStatus';

const highlights = [
  ['Runs locally', 'Your files and keys stay on this machine.'],
  ['Starts from a template', 'Choose a ready-made AI workflow from the marketplace.'],
  ['Shows its work', 'Open mission control to watch progress and results.'],
];

const steps = [
  {
    n: '1',
    title: 'Choose a template',
    body: 'Pick the kind of workflow you want: coding, research, content, operations, or something new.',
    href: '/marketplace',
    cta: 'Browse marketplace',
  },
  {
    n: '2',
    title: 'Add your AI key',
    body: 'Papercusp uses your own Anthropic or OpenAI credentials and keeps them local.',
    href: '/settings/api-keys',
    cta: 'Open settings',
  },
  {
    n: '3',
    title: 'Run the workflow',
    body: 'Papercusp launches a small team of AI roles that plan, do the work, and review the result.',
    href: '/harness',
    cta: 'Open mission control',
  },
];

const roles = [
  {
    title: 'Planner',
    body: 'Turns your goal into a clear sequence of tasks.',
  },
  {
    title: 'Worker',
    body: 'Does the actual work on your project or mission.',
  },
  {
    title: 'Reviewer',
    body: 'Checks the result before the workflow moves on.',
  },
];

export default function HomePage() {
  return (
    <div className="pc-shell pc-home">
      <section className="pc-home-hero" aria-labelledby="home-title">
        <div className="pc-hero-copy">
          <p className="pc-eyebrow">Local AI workflows, with clear steps and visible progress</p>
          <h1 id="home-title" className="pc-hero-logo">
            <img src="/wordmark.svg" alt="Papercusp" />
          </h1>
          <p className="pc-hero-lede">
            Papercusp helps you run repeatable AI workflows on your own machine. Pick a template, connect your key, and let a small AI team plan, work, and review the result.
          </p>
          <div className="pc-hero-actions" aria-label="Primary actions">
            <a href="/setup" className="pc-button primary">Start setup</a>
            <a href="/marketplace" className="pc-button">Browse marketplace</a>
          </div>
          <div className="pc-home-proof" aria-label="Why Papercusp is simple to understand">
            {highlights.map(([label, body]) => (
              <div key={label}>
                <strong>{label}</strong>
                <span>{body}</span>
              </div>
            ))}
          </div>
        </div>

        <aside className="pc-launch-console" aria-label="How Papercusp works">
          <div className="pc-console-topline">
            <span><i /> How it works</span>
            <strong>3 steps</strong>
          </div>
          <div className="pc-console-focus">
            <span>Simple first run</span>
            <h2>Pick a workflow. Add your key. Press run.</h2>
            <p>
              Papercusp calls these packaged workflows <strong>harnesses</strong>. A harness is just a reusable AI workflow: who helps, what they do, and how their work gets checked.
            </p>
          </div>
          <div className="pc-key-status-card">
            <div>
              <span>Key status</span>
              <strong>Uses your own credentials</strong>
            </div>
            <ApiKeyStatus />
          </div>
          <ol className="pc-launch-steps">
            {steps.map((step) => (
              <li key={step.n}>
                <span>{step.n}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.body}</p>
                </div>
                <a href={step.href}>{step.cta}</a>
              </li>
            ))}
          </ol>
          <div className="pc-home-note">
            Start with templates first. Add plugins later when you want extra tools or integrations.
          </div>
        </aside>
      </section>

      <section className="pc-home-story">
        <div className="pc-home-story-copy">
          <p className="pc-eyebrow">What happens when it runs</p>
          <h2>A small AI team works in turns.</h2>
          <p>
            Instead of one endless chat, Papercusp gives each role a focused job. That keeps work easier to inspect, easier to trust, and easier to correct.
          </p>
        </div>
        <div className="pc-home-role-grid">
          {roles.map((role) => (
            <article key={role.title} className="pc-card pc-home-role-card">
              <h3>{role.title}</h3>
              <p>{role.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="pc-home-cta-card">
        <div>
          <p className="pc-eyebrow">Start here</p>
          <h2>The simplest path is: marketplace → key → run.</h2>
          <p>
            If you are new, start with the marketplace. Choose a template that matches the kind of work you want Papercusp to help with, then follow the guided setup.
          </p>
        </div>
        <div className="pc-hero-actions">
          <a href="/marketplace" className="pc-button primary">Open marketplace</a>
          <a href="/setup" className="pc-button ghost">Open setup guide</a>
        </div>
      </section>

      <footer className="pc-home-footer">
        <span>Papercusp is a local control room for reusable AI workflows.</span>
        <a href="/docs/spec/why">Why Papercusp exists →</a>
      </footer>
    </div>
  );
}