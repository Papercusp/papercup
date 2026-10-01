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
  const probe = { stop: () => {
    if (active) {
      active = false;
      for (const restore of restores.reverse()) {
        try { restore(); } catch { unavailable.push('restore'); }
      }
    }
    return { clock: 'performance.now' as const, unit: 'ms' as const, startedAtMs,
      stoppedAtMs: performance.now(), maxRows: 200, maxDurationMs: 60_000,
      installed, unavailable, rows: rows.slice(), dropped, totalObserverWorkMs,
      nativeStartup: { rows: nativeStartupRows.slice(), dropped: nativeStartupDropped, maxRows: 20 } };
  } };
  (window as unknown as { __pcStartupStorageProbe: typeof probe }).__pcStartupStorageProbe = probe;
  return probe;
}
