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
  // r164's text LCP had no insertion/visibility evidence. Observe the known
  // candidate in the same early payload, independently of Storage's row cap.
  // Mutation callbacks never read layout; bounded frame reads are reported as
  // observer work, not attributed to the application or equated with paint.
  const render = {
    selector: '.pclsb-acct__foot', clock: 'performance.now' as const, unit: 'ms' as const,
    scope: 'first DOM observation and frame geometry/ancestor styles; not paint, clipping or occlusion',
    firstObservedAtMs: null as number | null, firstFrameAtMs: null as number | null,
    firstEligibleFrameAtMs: null as number | null,
    mutationCallbacks: 0, frameReads: 0, maxMutationCallbacks: 1000, maxFrameReads: 32,
    totalObserverWorkMs: 0, stopReason: 'collecting', unavailable: [] as string[],
    fonts: { initialStatus: null as string | null, readyAtMs: null as number | null,
      events: [] as Array<{ event: string; atMs: number; status: string }>, dropped: 0 },
  };
  let renderActive = true;
  let renderCandidate: HTMLElement | null = null;
  let renderObserver: MutationObserver | null = null;
  let renderFrame: number | null = null;
  let renderDeadline: number | null = null;
  const fontRestores: Array<() => void> = [];
  const stopRenderDom = (reason: string) => {
    if (render.stopReason === 'collecting') render.stopReason = reason;
    renderObserver?.disconnect();
    renderObserver = null;
    if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
    renderFrame = null;
  };
  const stopRender = () => {
    renderActive = false;
    stopRenderDom('stopped');
    if (renderDeadline !== null) window.clearTimeout(renderDeadline);
    renderDeadline = null;
    for (const restore of fontRestores.splice(0)) restore();
  };
  const findRenderCandidate = () => {
    if (!renderActive || render.stopReason !== 'collecting') return;
    if (performance.now() - startedAtMs >= 60_000) { stopRenderDom('deadline'); return; }
    const began = performance.now();
    try {
      const element = document.querySelector<HTMLElement>(render.selector);
      if (!element) return;
      if (renderCandidate && renderCandidate !== element) { stopRenderDom('candidate-replaced'); return; }
      renderCandidate = element;
      render.firstObservedAtMs ??= performance.now();
      if (renderFrame !== null) return;
      renderFrame = window.requestAnimationFrame(() => {
        renderFrame = null;
        if (!renderActive || render.stopReason !== 'collecting') return;
        if (performance.now() - startedAtMs >= 60_000) { stopRenderDom('deadline'); return; }
        if (render.frameReads >= render.maxFrameReads) { stopRenderDom('frame-cap'); return; }
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
          if (ancestor) { render.unavailable.push('ancestor-depth'); stopRenderDom('unavailable'); return; }
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 ||
              rect.top >= window.innerHeight || rect.left >= window.innerWidth) return;
          render.firstEligibleFrameAtMs = performance.now();
          stopRenderDom('eligible-frame');
        } catch {
          render.unavailable.push('frame-read'); stopRenderDom('unavailable');
        } finally { render.totalObserverWorkMs += performance.now() - beganFrame; }
      });
    } catch { render.unavailable.push('candidate-read'); stopRenderDom('unavailable'); }
    finally { render.totalObserverWorkMs += performance.now() - began; }
  };
  if (typeof document === 'undefined' || !document.documentElement) render.unavailable.push('document');
  if (typeof window.MutationObserver !== 'function') render.unavailable.push('MutationObserver');
  if (typeof window.requestAnimationFrame !== 'function' || typeof window.cancelAnimationFrame !== 'function') {
    render.unavailable.push('animation-frame');
  }
  if (render.unavailable.length) stopRenderDom('unavailable');
  else {
    try {
      renderObserver = new window.MutationObserver(() => {
        if (render.mutationCallbacks >= render.maxMutationCallbacks) { stopRenderDom('mutation-cap'); return; }
        render.mutationCallbacks++;
        findRenderCandidate();
      });
      renderObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden'] });
      findRenderCandidate();
      const fonts = document.fonts;
      if (fonts) {
        render.fonts.initialStatus = fonts.status;
        for (const event of ['loading', 'loadingdone', 'loadingerror']) {
          const listener = () => {
            if (!renderActive) return;
            if (render.fonts.events.length >= 8) { render.fonts.dropped++; return; }
            render.fonts.events.push({ event, atMs: performance.now(), status: fonts.status });
            findRenderCandidate();
          };
          fonts.addEventListener(event, listener);
          fontRestores.push(() => fonts.removeEventListener(event, listener));
        }
        void fonts.ready.then(() => {
          if (renderActive) { render.fonts.readyAtMs = performance.now(); findRenderCandidate(); }
        }, () => { if (renderActive) render.unavailable.push('fonts-ready'); });
      } else render.unavailable.push('fonts');
      renderDeadline = window.setTimeout(() => { stopRenderDom('deadline'); stopRender(); }, 60_000);
    } catch { render.unavailable.push('observer-install'); stopRenderDom('unavailable'); stopRender(); }
  }
  const probe = {
    // Compare identities while the LCP entry still holds its DOM node. Returning
    // null means unobserved; a selector match alone cannot join these timings.
    renderCandidateMatches: (element: unknown) => renderCandidate === null ? null : element === renderCandidate,
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
      render: { ...render, fonts: { ...render.fonts, events: render.fonts.events.slice() },
        unavailable: render.unavailable.slice() } };
  } };
  (window as unknown as { __pcStartupStorageProbe: typeof probe }).__pcStartupStorageProbe = probe;
  return probe;
}
