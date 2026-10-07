// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderPlanAuditReport } from './plan-audit-report';

describe('shared audit report workspace', () => {
  const rows = Array.from({ length: 83 }, (_, i) => ({ slug: 'plan-' + i, title: 'Plan ' + String(i).padStart(2, '0'), status: i % 2 ? 'active' : 'superseded', category: i % 2 ? 'Finish' : 'History', implementation: 'Built ' + i, citations: [{ path: 'src/' + i + '.ts' }], remaining: i }));
  const document = { rows, generatedAt: '2026-10-07T00:00:00Z', limitations: ['Stored history only'], extraOriginalEvidence: { retained: true } };
  const dom = () => new JSDOM(renderPlanAuditReport(document), { runScripts: 'dangerously', url: 'http://localhost/report#plan=plan-82' });
  it('retains the entire original JSON while mounting only one page of compact results', () => {
    const d = dom();
    expect(JSON.parse(d.window.document.getElementById('audit')!.textContent!)).toEqual(document);
    expect(d.window.document.querySelectorAll('#results button').length).toBeLessThanOrEqual(40);
    expect(d.window.document.getElementById('detail')!.textContent).toContain('Built 82');
    expect(d.window.document.getElementById('detail')!.textContent).toContain('src/82.ts');
  });
  it('filters categories and search, sorts, paginates, and renders honest empty state', () => {
    const d = dom(), doc = d.window.document;
    (doc.querySelector('[data-category="Finish"]') as HTMLButtonElement).click();
    expect(doc.getElementById('shown')!.textContent).toContain('41 of 83');
    (doc.getElementById('next') as HTMLButtonElement).click();
    expect(doc.querySelectorAll('#results button')).toHaveLength(1);
    const search = doc.getElementById('search') as HTMLInputElement;
    search.value = 'Plan 05';search.dispatchEvent(new d.window.Event('input'));
    expect(doc.getElementById('shown')!.textContent).toContain('1 of 83');
    search.value = 'no-match';search.dispatchEvent(new d.window.Event('input'));
    expect(doc.getElementById('detail')!.textContent).toContain('No matching plans');
  });
  it('escapes untrusted report prose and prevents embedded script breakout without losing strings', () => {
    const evil = '</script><script>window.compromised=true</script>';
    const d = new JSDOM(renderPlanAuditReport({ rows: [{ slug: 'evil', title: evil, recommendation: '<img src=x onerror=alert(1)>', citations: [{ path: evil }] }] }), { runScripts: 'dangerously', url: 'http://localhost/' });
    expect((d.window as unknown as { compromised?: boolean }).compromised).toBeUndefined();
    expect(d.window.document.querySelector('#detail img')).toBeNull();
    expect(d.window.document.getElementById('detail')!.textContent).toContain(evil);
  });
});
