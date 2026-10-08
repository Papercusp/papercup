/** Reports Library: real publish tool -> SSE list -> exact native Markdown/Mermaid reader. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';

async function verifyReports(evidenceDir: string) {
  assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Fixture publication requires isolated verifier state');
  const pid = process.env.VERIFY_TAURI_PID!;
  const workspace = process.env.PAPERCUSP_WORKSPACE!;
  assert.ok(pid && workspace && process.env.VERIFY_TAURI_POLL, 'Native bridge and polling helper required');
  mkdirSync(evidenceDir, { recursive: true });
  const native = (...args: string[]) => execFileSync(process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools',
    [...args, '--pid', pid], { encoding: 'utf8', timeout: 60_000 });
  const save = (name: string, value: unknown) => writeFileSync(join(evidenceDir, name), JSON.stringify(value, null, 2));
  const sourcePaths = ['apps/operator-vite/src/components/reports/ReportsRoute.tsx',
    'apps/operator-vite/src/components/reports/ReportsRoute.css',
    'apps/operator-vite/src/routes/reports.tsx', 'packages/operator-core/lib/sync-resolver/reports.ts',
    'packages/operator-core/lib/report-library.ts', 'packages/operator-core/lib/report-publication.ts',
    'packages/operator-core/lib/agent-tools/reports/publish.ts', 'packages/operator-core/lib/agent-tools/reports/_shared.ts'];
  const fingerprints = () => sourcePaths.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
  const before = fingerprints();
  let step = 0;
  const poll = (expression: string, require = '.reports-page') => {
    const output = execFileSync(process.env.VERIFY_TAURI_POLL!, ['--require', require, '--eval', expression],
      { encoding: 'utf8', timeout: 90_000, env: { ...process.env, VERIFY_TAURI_DOM_TIMEOUT: '60' } });
    writeFileSync(join(evidenceDir, `assert-${++step}.json`), output);
  };
  const title = 'Reports native verification';
  const body = '# Findings\n\nA complete private report.\n\n```mermaid\ngraph TD; A[Published] --> B[Reader]\n```\n';
  const subject = { kind: 'external', ref: 'reports-native-fixture', label: 'Native acceptance subject' };
  const publish = (args: Record<string, unknown>) => {
    native('eval', `window.__reportsPublication = { done: false }; void (async () => {
      try {
        const response = await fetch('/api/agent-mcp/run-tool', { method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify(${JSON.stringify({ name: 'reports:publish', args, confirmed: true })}) });
        const envelope = await response.json();
        const result = envelope.result;
        const record = result?.data ?? (result?.content?.find(x => x.type === 'text')
          ? JSON.parse(result.content.find(x => x.type === 'text').text) : result);
        window.__reportsPublication = { done:true, status:response.status, envelope, record };
      } catch(error) { window.__reportsPublication = { done:true, error:String(error) }; }
    })()`);
    poll('window.__reportsPublication?.done === true');
    const published = JSON.parse(native('eval', 'JSON.stringify(window.__reportsPublication)'));
    save(`publish-${step}.json`, published);
    assert.equal(published.status, 200, 'Native tool transport failed');
    assert.equal(published.record?.ok, true, 'Publisher refused the fixture');
    assert.ok(published.record.report_id && published.record.path, 'Publication must return an exact citation');
    return published.record;
  };
  try {
    native('navigate', `/reports?ws=${encodeURIComponent(workspace)}`, '--json');
    poll('!!document.querySelector(".reports-list")');
    const original = publish({ title, body_md: body, kind: 'audit', subject,
      request_key: 'reports-native-original', tags: ['native-fixture'] });
    // No refresh/navigation between publish and this assertion: arrival exercises SSE.
    poll(`Array.from(document.querySelectorAll('.reports-list-item')).some(n => n.textContent.includes(${JSON.stringify(title)}))`);
    native('navigate', `${original.path}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    poll(`(() => { const rows = Array.from(document.querySelectorAll('.reports-metadata > div'));
      const fields = Object.fromEntries(rows.map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
      return fields['Visibility'] === 'owner' && fields['Subject'] === ${JSON.stringify(subject.label)}
        && fields['Report ID'] === ${JSON.stringify(original.report_id)}
        && ['Written by', 'Pot', 'Published', 'Source'].every(key => !!fields[key]); })()`);
    poll(`Array.from(document.querySelectorAll('.reports-reader svg')).some(svg => svg.textContent.includes('Published') && svg.textContent.includes('Reader'))`);
    native('eval', `window.__reportsCopied = null; Object.defineProperty(navigator, 'clipboard', { configurable:true,
      value:{ writeText:async text => { window.__reportsCopied = text; } } });
      Array.from(document.querySelectorAll('.reports-actions button')).find(b => b.textContent === 'Copy as Markdown').click()`);
    poll(`window.__reportsCopied === ${JSON.stringify(`# ${title}\n\n${body}`)}`);
    const correctedTitle = `${title} corrected`;
    const correction = publish({ title: correctedTitle, body_md: body + '\nA correction.\n', supersedes: original.report_id,
      kind: 'audit', subject, request_key: 'reports-native-correction', tags: ['native-fixture'] });
    poll(`Array.from(document.querySelectorAll('.reports-list-item')).filter(n => n.textContent.includes('Reports native verification')).length === 1
      && document.querySelector('.reports-list-item')?.textContent.includes(${JSON.stringify(correctedTitle)})`);
    // Original citation remains pinned even after the superseding publication.
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    native('navigate', `${correction.path}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(correctedTitle)}`);
    native('eval', `Array.from(document.querySelectorAll('.reports-actions button')).find(b => b.textContent === 'Previous version').click()`);
    poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(original.report_id)}
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    native('eval', `Array.from(document.querySelectorAll('.reports-actions button')).find(b => b.textContent === 'Version history').click()`);
    poll(`new URL(location.href).searchParams.get('hist') === 'true'
      && document.querySelectorAll('.reports-history-item').length === 2`);
    native('eval', `Array.from(document.querySelectorAll('.reports-history-item')).find(b => b.textContent.includes(${JSON.stringify(correctedTitle)})).click()`);
    poll(`new URL(location.href).searchParams.get('sel') === ${JSON.stringify(correction.report_id)}
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(correctedTitle)}`);
    const filters = new URLSearchParams({ ws: workspace, kind: 'audit', subject: `${subject.kind}:${subject.ref}`,
      vis: 'owner', q: title, tag: 'native-fixture', since: '2000-01-01', sel: original.report_id, hist: 'true' });
    native('navigate', `/reports?${filters}`, '--json');
    poll(`document.querySelectorAll('.reports-list-item').length === 1
      && document.querySelector('.reports-list-item')?.textContent.includes(${JSON.stringify(correctedTitle)})
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}
      && document.querySelector('[aria-label="Search reports"]')?.value === ${JSON.stringify(title)}
      && document.querySelector('[aria-label="Report subject"]')?.value === ${JSON.stringify(`${subject.kind}:${subject.ref}`)}
      && document.querySelectorAll('.reports-history-item').length === 2`);
    filters.set('kind', 'review');
    native('navigate', `/reports?${filters}`, '--json');
    poll(`document.querySelectorAll('.reports-list-item').length === 0
      && document.querySelector('.reports-list')?.textContent.includes('No reports match')
      && document.querySelector('.reports-reader h2')?.textContent === ${JSON.stringify(title)}`);
    native('eval', `Array.from(document.querySelectorAll('.reports-heading button')).find(b => b.textContent === 'Clear filters').click()`);
    poll(`['kind','subject','pot','vis','q','tag','since'].every(key => !new URL(location.href).searchParams.has(key))
      && new URL(location.href).searchParams.get('sel') === ${JSON.stringify(original.report_id)}
      && Array.from(document.querySelectorAll('.reports-list-item')).some(b => b.textContent.includes(${JSON.stringify(correctedTitle)}))`);
    // The desktop's other panels can narrow Reports even on a wide viewport.
    poll(`document.querySelector('.reports-reader').getBoundingClientRect().width >= 300`);
    native('eval', `document.querySelector('.reports-reader').scrollIntoView({block:'start'})`);
    native('screenshot', '--output', join(evidenceDir, 'reports-reader.png'));
    native('eval', `document.querySelector('.reports-reader svg').scrollIntoView({block:'center'})`);
    native('screenshot', '--output', join(evidenceDir, 'reports-diagram.png'));
    // This is a separate author in the verifier's private database. The UI must
    // exercise the human-owner read path rather than pass by being the author.
    const { getOrgPg } = await import('@papercusp/db-org');
    const { publishReport } = await import('../packages/operator-core/lib/report-library');
    const sql = getOrgPg().sql;
    let privatePeer;
    try {
      privatePeer = await publishReport(sql, { workspaceId: workspace, title: 'Private peer audit',
        bodyMd: body, visibility: 'owner', source: 'native-owner-path-fixture' },
      { authorOwnerId: 'reports-native-foreign-author', authorSessionRef: 'native-owner-path', harnessSlug: 'other-pot' });
    } finally { await sql.end({ timeout: 5 }); }
    native('navigate', `/reports?sel=${encodeURIComponent(privatePeer.reportId)}&ws=${encodeURIComponent(workspace)}`, '--json');
    poll(`document.querySelector('.reports-reader h2')?.textContent === 'Private peer audit'
      && document.querySelector('.reports-metadata')?.textContent.includes('reports-native-foreign-author')
      && document.querySelector('.reports-metadata')?.textContent.includes('owner')`);
    native('screenshot', '--output', join(evidenceDir, 'reports-owner-private.png'));
    const after = fingerprints();
    assert.deepEqual(after, before, 'Relevant source changed during the verification window');
    save('manifest.json', { result: 'pass', original: original.report_id, correction: correction.report_id,
      privatePeer: privatePeer.reportId, sourceFingerprints: before, assertions: step,
      checked: ['publish-tool', 'SSE-arrival', 'deep-link', 'metadata', 'Mermaid-render', 'copy-exact-Markdown',
        'lineage-collapse', 'immutable-citation', 'previous-version', 'history-URL', 'history-navigation',
        'filter-restoration', 'filter-negative-control', 'clear-filters-preserves-citation', 'reader-width', 'human-owner-private-read'] });
  } catch (error) {
    save('failure.json', { error: String(error), step, sourceFingerprints: before,
      ui: native('eval', 'JSON.stringify({url:location.href, text:document.body.innerText})') });
    throw error;
  }
}

const selection = parseSelectionArgs(process.argv.slice(2));
const result = await runHarness({ contract: { name: 'reports-library-tauri',
  phases: [{ id: 'native', description: 'Real Reports publication, SSE and native reader' }] },
  evidenceRoot: defaultEvidenceRoot('reports-library-tauri'), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) { ctx.markStep('isolated-native-Reports'); await verifyReports(ctx.evidenceDir); return { ok: true }; },
});
console.log(`REPORTS_LIBRARY_TAURI_${result.verdict.toUpperCase()} evidence=${result.evidenceDir}`);
process.exitCode = result.verdict === 'pass' ? 0 : 1;
