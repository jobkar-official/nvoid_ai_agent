import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpServerConfig } from '../config/mcp-config.types';

@Injectable()
export class McpConfigService {
  private readonly logger = new Logger(McpConfigService.name);
  private servers: McpServerConfig[] = [];

  constructor(private readonly configService: ConfigService) {}

  load(): McpServerConfig[] {
    const configPath = resolve(process.cwd(), this.configService.get<string>('mcpServersConfig', './config/mcp-servers.json'));
    if (!existsSync(configPath)) {
      this.logger.warn(`MCP configuration file not found at ${configPath}; no MCP servers will be connected.`);
      this.servers = [];
      return this.servers;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to parse MCP config file: ${this.errorMessage(error)}`);
    }

    if (!Array.isArray(parsed)) throw new Error('MCP config must be a JSON array.');

    const ids = new Set<string>();
    const servers = parsed.map((entry, index) => this.validateEntry(entry, index));
    for (const server of servers) {
      if (ids.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
      ids.add(server.id);
    }

    const resolved = servers.map((server) => this.resolveEnvironment(server));
    this.servers = resolved.map((server) => {
      if (server.enabled) return server;
      const has = (...names: string[]) => names.every((name) => {
        const value = process.env[name];
        return Boolean(value?.trim() && !value.includes(String.fromCharCode(36) + '{'));
      });
      const canEnable =
        server.id === 'serper-search' && has('SERPER_API_KEY') ||
        server.id === 'serper-research' && has('SERPER_API_KEY') ||
        server.id === 'naukri' && has('NAUKRI_MCP_URL', 'NAUKRI_MCP_TOKEN') ||
        server.id === 'indeed' && has('INDEED_MCP_URL', 'INDEED_MCP_TOKEN') ||
        server.id === 'linkedin' && has('LINKEDIN_MCP_URL', 'LINKEDIN_MCP_TOKEN') ||
        server.id === 'glassdoor' && has('GLASSDOOR_MCP_URL', 'GLASSDOOR_MCP_TOKEN') ||
        server.id === 'apna' && has('APNA_MCP_URL', 'APNA_MCP_TOKEN') ||
        server.id === 'greenhouse' && has('GREENHOUSE_BOARDS') ||
        server.id === 'lever' && has('LEVER_SITES') ||
        server.id === 'ashby' && has('ASHBY_BOARDS') ||
        (server.id === 'apify-boards' || server.id === 'apify-apna') && has('APIFY_API_TOKEN') ||
        server.id === 'adzuna' && has('ADZUNA_APP_ID', 'ADZUNA_APP_KEY') ||
        server.id === 'jooble' && has('JOOBLE_API_KEY');
      return canEnable ? { ...server, enabled: true } : server;
    });
    return this.servers;
  }

  getAll(): McpServerConfig[] {
    return this.servers;
  }

  getEnabled(): McpServerConfig[] {
    return this.servers.filter((server) => server.enabled);
  }

  getById(id: string): McpServerConfig | undefined {
    return this.servers.find((server) => server.id === id);
  }

  private validateEntry(value: unknown, index: number): McpServerConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`MCP config entry ${index} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const id = entry.id;
    const name = entry.name;
    const transport = entry.transport;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`MCP config entry ${index} has an invalid id.`);
    }
    if (typeof name !== 'string' || !name.trim()) throw new Error(`MCP server ${id} requires a name.`);
    if (!['http', 'sse', 'stdio'].includes(String(transport))) {
      throw new Error(`MCP server ${id} transport must be http, sse, or stdio.`);
    }
    if (entry.enabled === true && (transport === 'http' || transport === 'sse') && typeof entry.url !== 'string') {
      throw new Error(`Enabled HTTP MCP server ${id} requires a url.`);
    }
    if (entry.enabled === true && transport === 'stdio' && typeof entry.command !== 'string') {
      throw new Error(`Enabled stdio MCP server ${id} requires a command.`);
    }
    return entry as unknown as McpServerConfig;
  }

  private resolveEnvironment<T>(value: T): T {
    if (typeof value === 'string') {
      return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => process.env[key] ?? `\${${key}}`) as T;
    }
    if (Array.isArray(value)) return value.map((item) => this.resolveEnvironment(item)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveEnvironment(item)])) as T;
    }
    return value;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
