export type McpTransportKind = 'http' | 'sse' | 'stdio';

export interface McpToolCallConfig {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  jobSearch?: McpToolCallConfig;
  jobApplication?: McpToolCallConfig;
}

export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  connected: boolean;
  toolCount: number;
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  error?: string;
}
