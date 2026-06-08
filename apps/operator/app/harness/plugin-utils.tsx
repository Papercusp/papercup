'use client';

// Shared plugin helpers used by HarnessPluginsSection (the per-harness plugin
// manager that lives in the Settings tab since the Config tab was retired —
// config-tab-cleanup-2026-06-08). Lives in its own module so consumers don't
// have to import a panel — same pattern as the standalone panel components
// (BrainstormFull, PrsTab, …).

import type { ComponentType } from 'react';
import {
  Activity, ArrowRight, AlertTriangle, BarChart, Bell, BookOpen, Box, Calendar,
  CheckCircle2, CheckSquare, Cloud, Code, Code2, Coins, Database, Download,
  FileText, Folder, FolderOpen, GitBranch, Globe, Image as ImageIcon, Inbox,
  Layers, LayoutDashboard, Lightbulb, LineChart, Link as LinkIcon, ListChecks,
  Loader2, Mail, MessageSquare, Music, PieChart, Play, Plus, Puzzle, RotateCcw,
  Search, Send, Server, Settings, Shield, SlidersHorizontal, Square,
  Star, Tag, Terminal, TrendingUp, Upload, Video, Wrench, Zap,
} from 'lucide-react';

/** Manifest-declared lucide icon name → component. Falls back to Puzzle. */
export const PLUGIN_ICON_MAP: Record<string, ComponentType<{ size?: number | string }>> = {
  Activity, ArrowRight, AlertTriangle, BarChart, Bell, BookOpen, Box, Calendar,
  CheckCircle2, CheckSquare, Cloud, Code, Code2, Coins, Database, Download,
  FileText, Folder, FolderOpen, GitBranch, Globe, Image: ImageIcon, Inbox,
  Layers, LayoutDashboard, Lightbulb, LineChart, Link: LinkIcon, ListChecks,
  Loader2, Mail, MessageSquare, Music, PieChart, Play, Plus, Puzzle, RotateCcw,
  Search, Send, Server, Settings, Shield, Slack: MessageSquare, SlidersHorizontal, Square,
  Star, Tag, Terminal, TrendingUp, Upload, Video, Wrench, Zap,
};

export function PluginIcon({ name, size = 13 }: { name?: string | null; size?: number }) {
  const Icon: ComponentType<{ size?: number | string }> = (name && PLUGIN_ICON_MAP[name]) || Puzzle;
  return <Icon size={size} />;
}

/**
 * The dir slug the CLI keys enable/disable by — the path basename (with the
 * `@scope/` parent kept), independent of the scoped manifest.name.
 */
export function pluginSlugFromPath(path: string | null | undefined, fallbackName: string): string {
  if (!path) return fallbackName;
  const parts = path.replace(/\/$/, '').split('/');
  const last = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (parent && parent.startsWith('@')) return `${parent}/${last}`;
  return last ?? fallbackName;
}

export interface InstalledPluginAction {
  name?: string;
  label?: string;
  surfaces?: string[];
  /** Optional manifest-declared lucide icon name. Resolved via PLUGIN_ICON_MAP. */
  icon?: string;
}

export interface InstalledPluginInfo {
  name: string;
  version?: string;
  description?: string;
  source?: string;
  icon?: string;
  /** Absolute on-disk path; basename is the dir slug the CLI keys enable/disable by. */
  path?: string;
  dashboardTabs?: Array<{ id?: string; label?: string; icon?: string }>;
  actions?: InstalledPluginAction[];
}

export interface EnabledPluginManifest extends InstalledPluginInfo {
  capabilities?: string[];
  actions?: Array<{ id?: string; name?: string; label?: string; description?: string; params?: Record<string, unknown> }>;
  routines?: Array<{ name?: string; trigger?: string }>;
  configSchema?: { properties?: Record<string, { default?: unknown; description?: string }> };
}
