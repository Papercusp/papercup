export interface EngineeringToolReaderConfig {
  origin: string; workspace: string; client: string; home: string;
  input: { harness: string };
}
export function readEngineeringTool(config: EngineeringToolReaderConfig, name: string,
  args: Record<string, unknown>, deps?: {
    request?: typeof fetch;
    read?: (path: string, encoding: string) => string;
    retain?: (name: string, status: number, bytes: string) => void;
  }): Promise<Record<string, unknown>>;
export function verifyEngineeringTauri(env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>>;
