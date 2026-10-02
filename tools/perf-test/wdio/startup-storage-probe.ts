/** Serialize into the diagnostic SPA's first inline script, before native
 * Storage access or application evaluation. No network or storage writes of
 * its own. Native results, receivers and thrown objects stay unchanged. */
export function installStartupStorageProbe() {
  const rows: Array<{ operation: string; area: string; key: string | null; valueBytes: number | null;
    startedAtMs: number; completedAtMs: number; durationMs: number; threw: boolean; caller: string | null }> = [];
  // Keep native media initialization visible even when frequent Storage calls
  // fill their separate budget. Looking up descriptors must not initialize it.
  const nativeStartupRows: typeof rows = [];
  const speechObjects = new WeakSet<object>();
  const installed: string[] = [];
  const unavailable: string[] = [];
  const restores: Array<() => void> = [];
  const areas = new WeakMap<object, string>();
  const startedAtMs = performance.now();
  let active = true;
  let totalObserverWorkMs = 0;
  let dropped = 0;
  let nativeStartupDropped = 0;
  const observe = (operation: string, area: string, receiver: unknown, args: unknown[], native: Function,
    nativeStartup = false) => {
    if (!active) return Reflect.apply(native, receiver, args);
    const started = performance.now();
    const collection = nativeStartup ? nativeStartupRows : rows;
    if (started - startedAtMs >= 60_000 || collection.length >= (nativeStartup ? 20 : 200)) {
      if (nativeStartup) nativeStartupDropped++;
      else dropped++;
      return Reflect.apply(native, receiver, args);
    }
    let threw = true;
    try {
      const value = Reflect.apply(native, receiver, args);
      threw = false;
      return value;
    } finally {
      const completed = performance.now();
      // Capture the still-present caller only for a slow native operation.
      // Never log stored values or coerce the caller's arguments a second time.
      collection.push({ operation, area, key: typeof args[0] === 'string' ? args[0].slice(0, 120) : null,
        valueBytes: operation === 'setItem' && typeof args[1] === 'string' ? args[1].length * 2 : null,
        startedAtMs: started, completedAtMs: completed, durationMs: completed - started, threw,
        caller: completed - started >= 5 ? new Error().stack?.slice(0, 1800) ?? null : null });
      totalObserverWorkMs += performance.now() - completed;
    }
  };
  const wrap = (object: object, key: string, operation: string, area: string, getter: boolean,
    nativeStartup = false) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const native = getter ? descriptor?.get : descriptor?.value;
    if (!descriptor || typeof native !== 'function' || descriptor.configurable === false) {
      unavailable.push(operation); return;
    }
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const resolvedArea = area || (typeof this === 'object' && this !== null ? areas.get(this) : null) || 'unknown';
      const value = observe(operation, resolvedArea, this, args, native, nativeStartup);
      if (getter && typeof value === 'object' && value !== null) areas.set(value, area);
      if (active && nativeStartup && key === 'speechSynthesis' && typeof value === 'object' && value !== null &&
          !speechObjects.has(value)) {
        speechObjects.add(value);
        let owner: object | null = value;
        while (owner && !Object.getOwnPropertyDescriptor(owner, 'getVoices')) owner = Object.getPrototypeOf(owner);
        if (owner) wrap(owner, 'getVoices', 'speechSynthesis.getVoices', 'speechSynthesis', false, true);
        else unavailable.push('speechSynthesis.getVoices');
      }
      return value;
    };
    try {
      Object.defineProperty(object, key, getter ? { ...descriptor, get: wrapper } : { ...descriptor, value: wrapper });
      installed.push(operation);
      restores.push(() => {
        const current = Object.getOwnPropertyDescriptor(object, key);
        if ((getter ? current?.get : current?.value) === wrapper) Object.defineProperty(object, key, descriptor);
      });
    } catch { unavailable.push(operation); }
  };
  // Looking up descriptors must not initialize localStorage before measuring it.
  for (const area of ['localStorage', 'sessionStorage']) {
    let owner: object | null = window;
    while (owner && !Object.getOwnPropertyDescriptor(owner, area)) owner = Object.getPrototypeOf(owner);
    if (owner) wrap(owner, area, `get:${area}`, area, true);
    else unavailable.push(`get:${area}`);
  }
  if (typeof Storage !== 'undefined') {
    for (const operation of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
      wrap(Storage.prototype, operation, operation, '', false);
    }
  } else unavailable.push('Storage.prototype');
  let speechOwner: object | null = window;
  while (speechOwner && !Object.getOwnPropertyDescriptor(speechOwner, 'speechSynthesis')) {
    speechOwner = Object.getPrototypeOf(speechOwner);
  }
  if (speechOwner) wrap(speechOwner, 'speechSynthesis', 'get:speechSynthesis', 'speechSynthesis', true, true);
  else unavailable.push('get:speechSynthesis');
  // The actual LCP can be the Plans subtitle or the account footer. Keep each
  // candidate's lifetime and timings separate in this same early payload.
  // Mutation callbacks never read layout; bounded frame reads are reported as
  // observer work, not attributed to the application or equated with paint.
  const renderCandidates = ['.pclsb-acct__foot', '.plans-pane__masthead-subtitle'].map((selector) => ({
    selector, clock: 'performance.now' as const, unit: 'ms' as const,
    scope: 'first DOM observation and frame geometry/ancestor styles; not paint, clipping or occlusion',
    firstObservedAtMs: null as number | null, firstFrameAtMs: null as number | null,
    firstEligibleFrameAtMs: null as number | null,
    mutationCallbacks: 0, frameReads: 0, maxMutationCallbacks: 1000, maxFrameReads: 32,
    totalObserverWorkMs: 0, stopReason: 'collecting', unavailable: [] as string[],
  }));
  const render = renderCandidates[0]!; // Preserve the existing footer report.
  const fontsReport = { initialStatus: null as string | null, readyAtMs: null as number | null,
    events: [] as Array<{ event: string; atMs: number; status: string }>, dropped: 0 };
  const candidates = renderCandidates.map((report) => ({ report,
    element: null as HTMLElement | null, frame: null as number | null }));
  type Candidate = typeof candidates[number];
  let renderActive = true;
  let renderObserver: MutationObserver | null = null;
  let renderDeadline: number | null = null;
  const fontRestores: Array<() => void> = [];
  const stopCandidate = (candidate: Candidate, reason: string) => {
    if (candidate.report.stopReason === 'collecting') candidate.report.stopReason = reason;
    if (candidate.frame !== null) window.cancelAnimationFrame(candidate.frame);
    candidate.frame = null;
    if (candidates.every(({ report }) => report.stopReason !== 'collecting')) {
      renderObserver?.disconnect();
      renderObserver = null;
    }
  };
  const stopRenderDom = (reason: string) => {
    for (const candidate of candidates) stopCandidate(candidate, reason);
  };
  const stopRender = () => {
    renderActive = false;
    stopRenderDom('stopped');
    if (renderDeadline !== null) window.clearTimeout(renderDeadline);
    renderDeadline = null;
    for (const restore of fontRestores.splice(0)) restore();
  };
  const findRenderCandidate = (candidate: Candidate) => {
    const render = candidate.report;
    if (!renderActive || render.stopReason !== 'collecting') return;
    if (performance.now() - startedAtMs >= 60_000) { stopRenderDom('deadline'); return; }
    const began = performance.now();
    try {
      const element = document.querySelector<HTMLElement>(render.selector);
      if (!element) return;
      if (candidate.element && candidate.element !== element) {
        candidate.element = null;
        stopCandidate(candidate, 'candidate-replaced'); return;
      }
      candidate.element = element;
      render.firstObservedAtMs ??= performance.now();
      if (candidate.frame !== null) return;
      candidate.frame = window.requestAnimationFrame(() => {
        candidate.frame = null;
        if (!renderActive || render.stopReason !== 'collecting') return;
        if (performance.now() - startedAtMs >= 60_000) { stopRenderDom('deadline'); return; }
        if (render.frameReads >= render.maxFrameReads) { stopCandidate(candidate, 'frame-cap'); return; }
        const beganFrame = performance.now();
        render.frameReads++;
        render.firstFrameAtMs ??= beganFrame;
        try {
          if (!element.isConnected) return;
          let ancestor: HTMLElement | null = element;
          for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
            const style = window.getComputedStyle(ancestor);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || Number(style.opacity) === 0) return;
          }
          if (ancestor) { render.unavailable.push('ancestor-depth'); stopCandidate(candidate, 'unavailable'); return; }
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
              rect.top >= window.innerHeight || rect.left >= window.innerWidth) return;
          render.firstEligibleFrameAtMs = performance.now();
          stopCandidate(candidate, 'eligible-frame');
        } catch {
          render.unavailable.push('frame-read'); stopCandidate(candidate, 'unavailable');
        } finally { render.totalObserverWorkMs += performance.now() - beganFrame; }
      });
    } catch { render.unavailable.push('candidate-read'); stopCandidate(candidate, 'unavailable'); }
    finally { render.totalObserverWorkMs += performance.now() - began; }
  };
  const findRenderCandidates = () => { for (const candidate of candidates) findRenderCandidate(candidate); };
  const renderUnavailable = (reason: string) => {
    for (const { report } of candidates) report.unavailable.push(reason);
  };
  if (typeof document === 'undefined' || !document.documentElement) renderUnavailable('document');
  if (typeof window.MutationObserver !== 'function') renderUnavailable('MutationObserver');
  if (typeof window.requestAnimationFrame !== 'function' || typeof window.cancelAnimationFrame !== 'function') {
    renderUnavailable('animation-frame');
  }
  if (render.unavailable.length) stopRenderDom('unavailable');
  else {
    try {
      renderObserver = new window.MutationObserver(() => {
        for (const candidate of candidates) {
          const render = candidate.report;
          if (render.stopReason !== 'collecting') continue;
          if (render.mutationCallbacks >= render.maxMutationCallbacks) { stopCandidate(candidate, 'mutation-cap'); continue; }
          render.mutationCallbacks++;
          findRenderCandidate(candidate);
        }
      });
      renderObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden'] });
      findRenderCandidates();
      const fonts = document.fonts;
      if (fonts) {
        fontsReport.initialStatus = fonts.status;
        for (const event of ['loading', 'loadingdone', 'loadingerror']) {
          const listener = () => {
            if (!renderActive) return;
            if (fontsReport.events.length >= 8) { fontsReport.dropped++; return; }
            fontsReport.events.push({ event, atMs: performance.now(), status: fonts.status });
            findRenderCandidates();
          };
          fonts.addEventListener(event, listener);
          fontRestores.push(() => fonts.removeEventListener(event, listener));
        }
        void fonts.ready.then(() => {
          if (renderActive) { fontsReport.readyAtMs = performance.now(); findRenderCandidates(); }
        }, () => { if (renderActive) renderUnavailable('fonts-ready'); });
      } else renderUnavailable('fonts');
      renderDeadline = window.setTimeout(() => { stopRenderDom('deadline'); stopRender(); }, 60_000);
    } catch { renderUnavailable('observer-install'); stopRenderDom('unavailable'); stopRender(); }
  }
  const probe = {
    // Compare identities while the LCP entry still holds its DOM node. Returning
    // null means unobserved; a selector match alone cannot join these timings.
    renderCandidateMatches: (element: unknown) => element == null || candidates[0]!.element === null
      ? null : element === candidates[0]!.element,
    renderCandidateMatchesBySelector: (element: unknown) => candidates.map((candidate) => ({
      selector: candidate.report.selector,
      matches: element == null || candidate.element === null ? null : element === candidate.element,
    })),
    stop: () => {
    if (active) {
      active = false;
      for (const restore of restores.reverse()) {
        try { restore(); } catch { unavailable.push('restore'); }
      }
      stopRender();
    }
    return { clock: 'performance.now' as const, unit: 'ms' as const, startedAtMs,
      stoppedAtMs: performance.now(), maxRows: 200, maxDurationMs: 60_000,
      installed, unavailable, rows: rows.slice(), dropped, totalObserverWorkMs,
      nativeStartup: { rows: nativeStartupRows.slice(), dropped: nativeStartupDropped, maxRows: 20 },
      render: { ...render, fonts: { ...fontsReport, events: fontsReport.events.slice() },
        unavailable: render.unavailable.slice(),
        candidates: renderCandidates.map((report) => ({ ...report, unavailable: report.unavailable.slice() })) } };
  } };
  (window as unknown as { __pcStartupStorageProbe: typeof probe }).__pcStartupStorageProbe = probe;
  return probe;
}
