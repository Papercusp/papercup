export declare function hostPreflight(input: { root: string; files: string[]; env: NodeJS.ProcessEnv }):
  | { verdict: 'admit'; setEnv: Record<string, string> }
  | { verdict: 'skipped'; reason: string }
  | { verdict: 'refuse'; message: string };
