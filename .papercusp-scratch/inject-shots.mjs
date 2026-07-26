/**
 * Injects the real Tauri/WebKitGTK screenshots into the pause/start artifact as
 * data URIs. Run from the repo root. Keeps the base64 out of the agent's
 * context — the script reads the files straight off disk.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PAGE = '.papercusp-scratch/pause-start-buttons.html';
const SHOTS = '/tmp/wi5989';

const b64 = (n) => `data:image/jpeg;base64,${readFileSync(`${SHOTS}/${n}`).toString('base64')}`;

const shipped = `
  <!-- SHIPPED ─────────────────────────────────────────────────── -->
  <section class="card" id="shipped">
    <div class="card-head">
      <p class="eyebrow">Shipped &amp; verified</p>
      <h2>What it actually looks like now</h2>
      <p>Real screenshots from a Tauri/WebKitGTK window, not a browser and not a mockup — the pane rendering live
      against the working tree. Cropped and magnified 3&times;.</p>
    </div>

    <div class="stage-grid">
      <div class="spec">
        <div class="spec-label"><span class="tag tag--b">Running &rarr; offers pause</span></div>
        <img src="${b64('shot-pause.jpg')}" alt="Blender routine rows, each with a circular amber pause button showing two solid bars" />
        <p class="spec-note">Amber circle, two solid bars. Reads as a pause button at a glance.</p>
      </div>
      <div class="spec">
        <div class="spec-label"><span class="tag tag--b">Paused &rarr; offers start</span></div>
        <img src="${b64('shot-play.jpg')}" alt="Agent rows: amber pause buttons on running routines, green solid play buttons on paused ones" />
        <p class="spec-note">Green circle, solid triangle. Running and paused rows are now
        distinguishable without reading a word.</p>
      </div>
    </div>

    <div class="stage-grid">
      <div class="spec">
        <div class="spec-label"><span class="tag tag--a">Header action</span></div>
        <img src="${b64('shot-header.jpg')}" alt="Blender pane header with a Pause all button: solid pause glyph on a tinted amber disc beside the label" />
        <p class="spec-note">Solid glyph on its own tinted disc. Green no longer means &ldquo;stop&rdquo; up here
        and &ldquo;start&rdquo; two rows below.</p>
      </div>
      <div class="spec">
        <div class="spec-label"><span class="tag tag--a">Arming rows</span></div>
        <img src="${b64('shot-arming.jpg')}" alt="Arming spend gates rows with shield and shield-off glyphs instead of play and pause" />
        <p class="spec-note">Shields, not transport glyphs &mdash; so &#9654;/&#9208; means exactly one thing
        in this pane.</p>
      </div>
    </div>

    <div class="verdict good">
      <p><strong>Measured in the real webview, not eyeballed.</strong> Every control computes
      <code>26&times;26</code> with the glyph offset from centre at <code>dx 0.00 / dy 0.00</code>
      (and <code>0.50</code> on the play triangle, the intended optical nudge). Before the fix that
      offset is what WebKitGTK silently got wrong.</p>
    </div>

    <div class="verdict">
      <p><strong>One bug the tests could never have caught.</strong> I first sized the control 24&times;24 &mdash;
      but <code>globals.css</code> has a <code>:where(button)</code> baseline carrying a
      <code>min-height: 26px</code> tap-target floor. Because <code>:where()</code> has zero specificity,
      every property I set won <em>except</em> the one I never declared, so the button rendered a
      24&times;26 <em>egg</em> instead of a circle. Nothing failed; it only showed up when I measured
      real pixels. Now it matches the floor at 26&times;26 rather than fighting it.</p>
    </div>
  </section>
`;

let html = readFileSync(PAGE, 'utf-8');
if (html.includes('id="shipped"')) {
  html = html.replace(/\n  <!-- SHIPPED[\s\S]*?<\/section>\n/, '\n');
}
html = html.replace(
  '  <!-- 6 ─────────────────────────────────────────────────────────── -->',
  `${shipped}\n  <!-- 6 ─────────────────────────────────────────────────────────── -->`,
);
// The open questions are answered now — retitle that closing block.
html = html.replace('<h2>What I need from you</h2>', '<h2>The two calls you made</h2>');
html = html.replace(
  '<strong>Option A or Option B?</strong> A is a quiet neutral circle that colours on hover — calmer in a long list.\n        B is always tinted green/amber — scans from further away, but a pane with twenty routines becomes a Christmas tree.',
  '<strong>Option B — always tinted.</strong> Shipped: green start, amber pause, colour on at rest. Worth a look in the Agents tab, where a long run of paused rows is now a column of green — louder than Option A would have been, which was the tradeoff.',
);
html = html.replace(
  '<strong>Should the header buttons change too,</strong> or is green-means-stop there something you deliberately want kept?\n        You approved that green a day ago, so I won’t touch it without you saying so.',
  '<strong>Yes, change the header too.</strong> Shipped: the 2026-07-25 green-means-stop rule is superseded and recorded as such in the stylesheet, so it does not get reinstated by the next pass.',
);
html = html.replace(
  'I&rsquo;d verify the result in a real Tauri window I spawn myself,\n      not Chromium &mdash; section 3 is exactly the bug a browser check would miss.',
  'Verified in a real Tauri window, plus 7 new regression tests that fail if the glyph loses its fill or the layout moves back onto the &lt;button&gt;.',
);
html = html.replace(
  '.spec-note { font-size: 13px; color: var(--page-dim); }',
  '.spec-note { font-size: 13px; color: var(--page-dim); }\n  .spec img { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--page-line); }',
);

writeFileSync(PAGE, html);
console.log('injected', html.length, 'bytes');
