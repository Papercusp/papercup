'use client';

/**
 * P-106 read-mode decorations for plan markdown rendered by
 * Vditor.preview(). DOM-walking post-render (the documented zero-risk
 * path per D-003 of plans-admin-ui-2026-05-20); no Lute walker
 * protocol involved. P-202 will register the equivalent decorations
 * into IR's Md2VditorIRDOM pipeline once D-003's spike resolves.
 *
 *   1. <code>todo</code> → <code data-plan-status="todo"
 *      class="pc-plan-status pc-plan-status--todo">todo</code>
 *   2. <li><strong>P-001</strong>...</li> → <li data-plan-item="P-001">,
 *      plus a sibling <sup class="pc-plan-badge"> rendering
 *      effectiveStatus when it differs from storedStatus.
 *   3. text "P-001" / "D-001" (outside its own item header, outside
 *      existing anchors / code / pre) → <a class="pc-plan-ref"
 *      data-plan-ref="P-001">P-001</a>.
 *
 * Click on a [data-plan-ref] scrolls the matching [data-plan-item] (or
 * its decision heading for D-NNN) into view and pulses
 * .pc-plan-highlight for 1.5s.
 */

import type { PlanItem } from './plans-api';

const STATUS_TOKEN_RE = /^(todo|wip|blocked|needs-human|done|dropped)$/;
const PLAN_ID_RE = /^[PD]-\d{3,}$/;
const PLAN_REF_RE = /\b([PD]-\d{3,})\b/g;

export function decoratePlanDom(root: HTMLElement, items: PlanItem[] | undefined): void {
  const byId = new Map<string, PlanItem>();
  if (items) for (const it of items) byId.set(it.id, it);

  // 1. Status tokens — every inline <code> that holds an enum value.
  for (const code of Array.from(root.querySelectorAll('code'))) {
    if (code.dataset.planStatus) continue;
    if (code.closest('pre')) continue;
    const txt = (code.textContent ?? '').trim();
    if (!STATUS_TOKEN_RE.test(txt)) continue;
    code.dataset.planStatus = txt;
    code.classList.add('pc-plan-status', `pc-plan-status--${txt}`);
  }

  // 2. List-item IDs + effective-status badge.
  for (const li of Array.from(root.querySelectorAll('li'))) {
    if (li.dataset.planItem) continue;
    const firstStrong =
      li.querySelector<HTMLElement>(':scope > strong') ??
      li.querySelector<HTMLElement>(':scope > p > strong');
    if (!firstStrong) continue;
    const id = (firstStrong.textContent ?? '').trim();
    if (!PLAN_ID_RE.test(id)) continue;
    li.dataset.planItem = id;

    const item = byId.get(id);
    if (item && item.effectiveStatus !== item.storedStatus) {
      const statusCode = li.querySelector<HTMLElement>(
        `code[data-plan-status="${item.storedStatus}"]`,
      );
      const anchor = statusCode ?? firstStrong;
      const already = anchor.nextElementSibling;
      if (!already || !already.classList?.contains('pc-plan-badge')) {
        const badge = document.createElement('sup');
        badge.className = `pc-plan-badge pc-plan-badge--${item.effectiveStatus}`;
        badge.textContent = item.effectiveStatus;
        badge.title = `effective: ${item.effectiveStatus} (stored: ${item.storedStatus})`;
        anchor.after(badge);
      }
    }
  }

  // 3. Bare P-NNN / D-NNN references in prose → click-to-scroll links.
  wrapTextRefs(root);
}

function wrapTextRefs(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre, .pc-plan-ref')) return NodeFilter.FILTER_REJECT;
      // The leading <strong>P-NNN</strong> of an item is the item's
      // own canonical ID, not a reference to it.
      if (
        parent.tagName === 'STRONG' &&
        parent.parentElement?.closest('li[data-plan-item]')
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      const v = node.nodeValue ?? '';
      PLAN_REF_RE.lastIndex = 0;
      const hit = PLAN_REF_RE.test(v);
      PLAN_REF_RE.lastIndex = 0;
      return hit ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let cur: Node | null = walker.nextNode();
  while (cur) {
    targets.push(cur as Text);
    cur = walker.nextNode();
  }

  for (const text of targets) {
    const value = text.nodeValue ?? '';
    PLAN_REF_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = PLAN_REF_RE.exec(value)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) frag.appendChild(document.createTextNode(value.slice(last, start)));
      const a = document.createElement('a');
      const id = m[1] ?? '';
      a.className = 'pc-plan-ref';
      a.dataset.planRef = id;
      a.textContent = id;
      a.href = `#${id}`;
      frag.appendChild(a);
      last = end;
    }
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    text.replaceWith(frag);
  }
}

/**
 * Attach a delegated click listener on the rendered preview root.
 * Returns a teardown the caller invokes before re-attaching or on
 * unmount.
 */
export function attachPlanRefClickHandler(root: HTMLElement): () => void {
  const handler = (event: Event) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest('[data-plan-ref]') as HTMLElement | null;
    if (!anchor) return;
    const id = anchor.dataset.planRef;
    if (!id) return;
    event.preventDefault();
    const dest = findRefTarget(root, id);
    if (!dest) return;
    dest.scrollIntoView({ block: 'center', behavior: 'smooth' });
    dest.classList.add('pc-plan-highlight');
    setTimeout(() => dest.classList.remove('pc-plan-highlight'), 1500);
  };
  root.addEventListener('click', handler);
  return () => root.removeEventListener('click', handler);
}

function findRefTarget(root: HTMLElement, id: string): HTMLElement | null {
  if (id.startsWith('P-')) {
    return root.querySelector<HTMLElement>(`[data-plan-item="${id}"]`);
  }
  // D-NNN — Vditor's `anchor: 1` slugifies heading text into an id;
  // the leading `D-001` becomes the id of the <h3>.
  const byId = root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (byId) return byId;
  for (const h of Array.from(root.querySelectorAll<HTMLElement>('h3'))) {
    const t = (h.textContent ?? '').trim();
    if (t.startsWith(id)) return h;
  }
  return null;
}
