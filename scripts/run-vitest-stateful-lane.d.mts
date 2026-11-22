import type { Writable } from "node:stream";

type Environment = Readonly<Record<string, string | undefined>>;

export function runStatefulLane(options?: {
  env?: Environment;
  forwardedArgs?: string[];
  run?: (args: string[], options: { env: Environment; stderr: Pick<Writable, "write"> }) => number | Promise<number>;
  stderr?: Pick<Writable, "write">;
  wsAbsDir?: string;
}): Promise<number>;
