/** Minimal request-context shim for client-reachable server modules. */
export class AsyncLocalStorage<T> {
  private value: T | undefined;

  run<R>(store: T, callback: () => R): R {
    const previous = this.value;
    this.value = store;
    try {
      return callback();
    } finally {
      this.value = previous;
    }
  }

  getStore(): T | undefined {
    return this.value;
  }

  enterWith(store: T): void {
    this.value = store;
  }

  disable(): void {
    this.value = undefined;
  }
}
