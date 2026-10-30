import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { McpServerConfig, McpServerStatus } from '../config/mcp-config.types';
import { withTimeout } from '../common/async';
import { McpConfigService } from './mcp-config.service';

type SupportedTransport = StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;
type ToolInfo = { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown };

interface ConnectedMcpServer {
  config: McpServerConfig;
  client: Client;
  transport: SupportedTransport;
  tools: ToolInfo[];
  connected: boolean;
  error?: string;
}

@Injectable()
export class McpRegistryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(McpRegistryService.name);
  private readonly servers = new Map<string, ConnectedMcpServer>();
  private readonly statuses = new Map<string, McpServerStatus>();

  constructor(
    private readonly config: McpConfigService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const configured = this.config.load();
    const enabled = configured.filter((server) => server.enabled);

    for (const server of configured.filter((item) => !item.enabled)) {
      this.statuses.set(server.id, {
        id: server.id,
        name: server.name,
        enabled: false,
        transport: server.transport,
        connected: false,
        toolCount: 0,
        tools: [],
      });
    }

    if (enabled.length === 0) {
      this.logger.warn('No MCP servers are enabled. Add endpoints/tokens to config/mcp-servers.json and enable the connectors.');
      return;
    }

    await Promise.all(enabled.map((server) => this.connectServer(server)));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map(async (server) => {
      try {
        await server.client.close();
      } catch (error) {
        this.logger.warn(`Failed to close MCP server ${server.config.id}: ${this.errorMessage(error)}`);
      }
    }));
  }

  getStatuses(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  getConnectedServerIds(): string[] {
    return [...this.servers.values()].filter((server) => server.connected).map((server) => server.config.id);
  }

  getJobSearchServers(): Array<{ server: McpServerConfig; tool: string; argumentsTemplate: Record<string, unknown>; inputSchema?: unknown; configured: boolean }> {
    const matches: Array<{ server: McpServerConfig; tool: string; argumentsTemplate: Record<string, unknown>; inputSchema?: unknown; configured: boolean }> = [];
    for (const entry of this.servers.values()) {
      if (!entry.connected) continue;
      const configuredToolName = entry.config.jobSearch?.tool;
      const isPlaceholderTool = !configuredToolName || /^(replace_|todo|auto_discover)/i.test(configuredToolName);
      const configuredTool = !isPlaceholderTool
        ? entry.tools.find((item) => item.name === configuredToolName)
        : undefined;
      if (configuredTool) {
        matches.push({ server: entry.config, tool: configuredTool.name, argumentsTemplate: entry.config.jobSearch?.arguments ?? {}, inputSchema: configuredTool.inputSchema, configured: true });
        continue;
      }
      const candidate = entry.tools.find((tool) => {
        const identity = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
        return /(search|find|list|discover|fetch).{0,45}(jobs?|vacanc(?:y|ies)|open.?roles?|positions?|opportunit(?:y|ies)|recruitment|tenders?)|(jobs?|vacanc(?:y|ies)|open.?roles?|positions?|opportunit(?:y|ies)|recruitment|tenders?).{0,45}(search|find|list|discover|fetch)/i.test(identity)
          && !/(apply|submit|application|delete|remove|update|create)/i.test(tool.name);
      });
      if (candidate) matches.push({ server: entry.config, tool: candidate.name, argumentsTemplate: {}, inputSchema: candidate.inputSchema, configured: false });
    }
    return matches;
  }

  getJobApplicationConfig(serverId: string): { server: McpServerConfig; tool: string; argumentsTemplate: Record<string, unknown> } | undefined {
    const entry = this.servers.get(serverId);
    if (!entry?.connected || !entry.config.jobApplication?.tool) return undefined;
    return {
      server: entry.config,
      tool: entry.config.jobApplication.tool,
      argumentsTemplate: entry.config.jobApplication.arguments,
    };
  }

  getToolCatalog(serverId?: string): Array<{ serverId: string; serverName: string; tools: ToolInfo[] }> {
    const entries = [...this.servers.values()].filter((entry) => !serverId || entry.config.id === serverId);
    return entries.map((entry) => ({
      serverId: entry.config.id,
      serverName: entry.config.name,
      tools: entry.tools,
    }));
  }

  getToolInputSchema(serverId: string, toolName: string): unknown {
    const entry = this.requireConnectedServer(serverId);
    return entry.tools.find((tool) => tool.name === toolName)?.inputSchema;
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.requireConnectedServer(serverId);
    const registeredTool = entry.tools.find((tool) => tool.name === toolName);
    if (!registeredTool) throw new Error(`Tool ${toolName} is not available on MCP server ${serverId}.`);

    const configuredTimeoutMs = this.configService.get<number>('mcpCallTimeoutMs', 210000);
    const timeoutMs = serverId === 'serper-search'
      ? Math.max(configuredTimeoutMs, 300000)
      : ['apify-boards', 'apify-apna'].includes(serverId)
        ? Math.max(configuredTimeoutMs, 200000)
        : configuredTimeoutMs;
    const result = await withTimeout(entry.client.callTool({ name: toolName, arguments: args }), timeoutMs, `MCP call ${serverId}/${toolName}`);

    if (result && typeof result === 'object' && 'isError' in result && result.isError) {
      const detail = 'content' in result ? JSON.stringify(result.content) : 'MCP tool returned an error.';
      throw new Error(detail.slice(0, 1000));
    }
    return result;
  }

  private async connectServer(serverConfig: McpServerConfig): Promise<void> {
    let client: Client | undefined;
    let transport: SupportedTransport | undefined;
    try {
      this.assertCredentialsResolved(serverConfig);
      client = new Client({ name: 'job-agent-worker', version: '1.0.0' });
      transport = this.createTransport(serverConfig);
      const timeoutMs = this.configService.get<number>('mcpConnectTimeoutMs', 15000);
      await withTimeout(client.connect(transport), timeoutMs, `MCP connection ${serverConfig.id}`);
      const toolResult = await client.listTools();
      const tools = toolResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: 'outputSchema' in tool ? tool.outputSchema : undefined,
      }));

      const connected: ConnectedMcpServer = { config: serverConfig, client, transport, tools, connected: true };
      this.servers.set(serverConfig.id, connected);
      this.statuses.set(serverConfig.id, {
        id: serverConfig.id,
        name: serverConfig.name,
        enabled: true,
        transport: serverConfig.transport,
        connected: true,
        toolCount: tools.length,
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      this.logger.log(`Connected MCP server ${serverConfig.id} with ${tools.length} tool(s).`);
    } catch (error) {
      if (client) await client.close().catch(() => undefined);
      const message = this.errorMessage(error);
      this.statuses.set(serverConfig.id, {
        id: serverConfig.id,
        name: serverConfig.name,
        enabled: true,
        transport: serverConfig.transport,
        connected: false,
        toolCount: 0,
        tools: [],
        error: message,
      });
      this.logger.error(`MCP server ${serverConfig.id} failed to connect: ${message}`);
    }
  }

  private createTransport(config: McpServerConfig): SupportedTransport {
    if (config.transport === 'http') {
      const url = new URL(config.url!);
      return new StreamableHTTPClientTransport(url, {
        requestInit: { headers: config.headers ?? {} },
      });
    }

    if (config.transport === 'sse') {
      return new SSEClientTransport(new URL(config.url!), {
        requestInit: { headers: config.headers ?? {} },
      });
    }

    const inheritedEnvKeys = [
      'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
      'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'PATHEXT',
      'SERPER_SEARCH_MAX_RESULTS', 'SERPER_SEARCH_MAX_QUERIES', 'SERPER_SEARCH_MAX_PAGES_PER_QUERY',
      'SERPER_SEARCH_MAX_REQUESTS', 'SERPER_SEARCH_MAX_PAGE_FETCHES', 'SERPER_SEARCH_CONCURRENCY',
      'SERPER_SEARCH_PAGE_CRAWL_CONCURRENCY',
    ];
    const inheritedEnv = Object.fromEntries(
      inheritedEnvKeys
        .filter((key) => typeof process.env[key] === 'string')
        .map((key) => [key, process.env[key] as string]),
    );
    return new StdioClientTransport({
      command: config.command!,
      args: config.args ?? [],
      cwd: config.cwd,
      env: { ...inheritedEnv, ...(config.env ?? {}) },
    });
  }

  private requireConnectedServer(serverId: string): ConnectedMcpServer {
    const server = this.servers.get(serverId);
    if (!server?.connected) throw new Error(`MCP server ${serverId} is not connected.`);
    return server;
  }

  private assertCredentialsResolved(config: McpServerConfig): void {
    const serialized = JSON.stringify(config);
    const unresolved = serialized.match(/\$\{[A-Z0-9_]+\}/);
    if (unresolved) throw new Error(`Configuration for ${config.id} contains an unresolved environment variable placeholder.`);
    if ((config.transport === 'http' || config.transport === 'sse') && config.url?.includes('REPLACE-WITH')) {
      throw new Error(`Configure the MCP URL for ${config.id} before enabling it.`);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
