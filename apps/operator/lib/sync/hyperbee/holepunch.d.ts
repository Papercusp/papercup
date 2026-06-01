/**
 * Minimal type shims for the Holepunch native deps used by the
 * Hyperbee substrate. Upstream packages don't ship .d.ts files;
 * declaring the surface we actually use here gets us strict-mode
 * type safety on the substrate code while leaving the rest of the
 * surfaces `any` where consumers don't need them.
 */

declare module 'corestore' {
  export default class Corestore {
    constructor(storage: string | unknown, opts?: Record<string, unknown>);
    ready(): Promise<void>;
    close(): Promise<void>;
    get(opts: { name?: string; key?: Buffer; valueEncoding?: string } | string): unknown;
    // `replicate(initiator: boolean)` returns a duplex stream to pipe by hand.
    // `replicate(stream)` plugs into an EXTERNAL stream (a Hyperswarm
    // connection / secret-stream) — it both replicates AND attaches the shared
    // muxer at `stream.userData` (Model B announce channel rides that muxer).
    replicate(initiatorOrStream: boolean | unknown): unknown;
  }
}

declare module 'protomux' {
  // Minimal surface — the Model B announce channel rides the SAME muxer that
  // corestore.replicate(socket) attaches at `socket.userData`. We open one
  // extra channel + one JSON message on it.
  export interface ProtomuxMessage<T = unknown> {
    send(value: T): void;
  }
  export interface ProtomuxChannel {
    addMessage<T = unknown>(opts: {
      encoding: unknown;
      onmessage: (value: T) => void;
    }): ProtomuxMessage<T>;
    open(): void;
    close(): void;
  }
  export default class Protomux {
    static from(stream: unknown): Protomux;
    createChannel(opts: { protocol: string }): ProtomuxChannel;
  }
}

declare module 'compact-encoding' {
  // We only use the `json` codec for the announce frame.
  const c: { json: unknown; [k: string]: unknown };
  export default c;
}

declare module 'autobase' {
  export default class Autobase {
    constructor(
      store: unknown,
      bootstrap: Buffer | null,
      opts: {
        apply: (
          nodes: ReadonlyArray<{ value: unknown }>,
          view: { append: (op: unknown) => Promise<void>; length?: number },
          host: { addWriter: (key: Buffer) => Promise<void> },
        ) => Promise<void>;
        open: (store: unknown) => unknown;
      },
    );
    ready(): Promise<void>;
    close(): Promise<void>;
    append(op: unknown): Promise<void>;
    view: { length: number; append: (op: unknown) => Promise<void> };
    local: { key: Buffer };
    key: Buffer;
  }
}

declare module 'hyperswarm' {
  import type { EventEmitter } from 'node:events';
  // Minimal surface — we use join/leave/destroy + the 'connection' event.
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: Record<string, unknown>);
    join(
      topic: Buffer,
      opts?: { server?: boolean; client?: boolean },
    ): { flushed(): Promise<void> };
    leave(topic: Buffer): Promise<void> | void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', listener: (socket: unknown, info: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}

declare module 'hyperbee' {
  export default class Hyperbee {
    constructor(feed: unknown, opts?: Record<string, unknown>);
    ready(): Promise<void>;
    put(key: string, value: unknown): Promise<void>;
    get(key: string): Promise<{ key: string; value: unknown } | null>;
    del(key: string): Promise<void>;
  }
}
