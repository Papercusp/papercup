export declare const PSU_CLAUDE_MCP_SERVER: 'papercusp-su';
export declare const PSU_CLAUDE_MCP_TEMPLATE_FILE: string;
export declare const PSU_CLAUDE_SETTINGS_OVERLAY_FILE: string;

export interface PsuClaudeMcpEntry {
  type: string;
  url: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export declare function psuClaudeMcpTemplatePath(home: string): string;
export declare function psuClaudeSettingsOverlayPath(home: string): string;
export declare function readPsuClaudeMcpEntry(home: string): PsuClaudeMcpEntry | null;
export declare function readPsuClaudeMcpEntryAsync(home: string): Promise<PsuClaudeMcpEntry | null>;
export declare function readPsuClaudeSettingsOverlay(home: string): Record<string, any> | null;
export declare function readPsuClaudeSettingsOverlayAsync(home: string): Promise<Record<string, any> | null>;
export declare function applyPsuClaudeSettingsOverlay(
  base: Record<string, any> | null | undefined,
  overlay: Record<string, any> | null | undefined,
): Record<string, any>;
export declare function stripLegacyPsuClaudeJson(cfg: Record<string, any> | null | undefined): boolean;
export declare function stripLegacyPsuClaudeSettings(cfg: Record<string, any> | null | undefined, home: string): string[];
