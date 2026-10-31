import {
  extractResearchRecords,
  inferResearchArguments,
  isReadOnlyResearchTool,
  ResearchService,
} from './research.service';

describe('read-only research tool selection', () => {
  it('accepts tools explicitly annotated as read-only', () => {
    expect(isReadOnlyResearchTool({
      name: 'lookupRecords',
      annotations: { readOnlyHint: true },
    })).toBe(true);
  });

  it('rejects mutating names even when the connector incorrectly marks them read-only', () => {
    expect(isReadOnlyResearchTool({
      name: 'delete_records',
      annotations: { readOnlyHint: true },
    })).toBe(false);
    expect(isReadOnlyResearchTool({
      name: 'submit_application',
      annotations: { readOnlyHint: true },
    })).toBe(false);
  });

  it('rejects destructive or explicitly non-read-only annotations', () => {
    expect(isReadOnlyResearchTool({
      name: 'search_contacts',
      annotations: { destructiveHint: true },
    })).toBe(false);
    expect(isReadOnlyResearchTool({
      name: 'lookup_contacts',
      annotations: { readOnlyHint: false },
    })).toBe(false);
  });

  it('recognizes read operations by tool name when annotations are absent', () => {
    expect(isReadOnlyResearchTool({ name: 'search_contacts' })).toBe(true);
    expect(isReadOnlyResearchTool({ name: 'list_companies' })).toBe(true);
    expect(isReadOnlyResearchTool({ name: 'create_contact' })).toBe(false);
  });

  it('recognizes camelCase search tools and blocks camelCase mutations', () => {
    expect(isReadOnlyResearchTool({ name: 'searchContacts' })).toBe(true);
    expect(isReadOnlyResearchTool({ name: 'getIssues' })).toBe(true);
    expect(isReadOnlyResearchTool({ name: 'submitApplication' })).toBe(false);
  });
});

describe('research MCP argument mapping', () => {
  it('maps user query and bulk limit to declared schema fields', () => {
    expect(inferResearchArguments('Find product managers in Delhi', {
      type: 'object',
      properties: {
        searchTerm: { type: 'string' },
        maxResults: { type: 'integer' },
        location: { type: 'string' },
      },
      required: ['searchTerm', 'maxResults'],
    }, 250)).toEqual({
      searchTerm: 'Find product managers in Delhi',
      maxResults: 250,
      location: 'Delhi',
    });
  });

  it('does not invent unknown required arguments', () => {
    expect(inferResearchArguments('Find product managers', {
      type: 'object',
      properties: {
        query: { type: 'string' },
        accountId: { type: 'string' },
      },
      required: ['query', 'accountId'],
    }, 100)).toBeUndefined();
  });

  it('infers an explicit country code without confusing it with the city', () => {
    expect(inferResearchArguments('Find Java engineers in the United States', {
      type: 'object',
      properties: {
        query: { type: 'string' },
        country: { type: 'string' },
      },
      required: ['query'],
    }, 100)).toEqual({
      query: 'Find Java engineers in the United States',
      country: 'US',
    });
  });

  it('does not treat an extracted city as a country code or countries list', () => {
    expect(inferResearchArguments('Find software engineers in Bengaluru', {
      type: 'object',
      properties: {
        query: { type: 'string' },
        countries: { type: 'array', items: { type: 'string' } },
      },
      required: ['query', 'countries'],
    }, 100)).toBeUndefined();
  });

  it('supports an empty argument object when the tool requires no input', () => {
    expect(inferResearchArguments('Show current metrics', {
      type: 'object',
      properties: {},
      required: [],
    }, 100)).toEqual({});
  });
});

describe('MCP research result extraction', () => {
  it('extracts structured arrays from actual MCP results', () => {
    expect(extractResearchRecords({
      structuredContent: {
        jobs: [{ id: '1', title: 'Backend Engineer' }, { id: '2', title: 'Platform Engineer' }],
      },
    })).toHaveLength(2);
  });

  it('parses JSON text content returned by MCP tools', () => {
    expect(extractResearchRecords({
      content: [{ type: 'text', text: JSON.stringify({ records: [{ id: '1' }, { id: '2' }] }) }],
    })).toHaveLength(2);
  });

  it('preserves plain-text output as a real source record', () => {
    expect(extractResearchRecords({
      content: [{ type: 'text', text: 'Current openings: 12' }],
    })).toEqual([{ text: 'Current openings: 12' }]);
  });
});

describe('ResearchService', () => {
  it('executes only connected read-only tools and returns dynamic source records', async () => {
    const registry = {
      getStatuses: () => [
        { id: 'crm', name: 'Connected CRM', connected: true },
        { id: 'unsafe', name: 'Unsafe MCP', connected: true },
      ],
      getToolCatalog: () => [
        {
          serverId: 'crm',
          serverName: 'Connected CRM',
          tools: [{
            name: 'search_contacts',
            description: 'Search CRM contacts',
            inputSchema: {
              type: 'object',
              properties: { query: { type: 'string' }, limit: { type: 'integer' } },
              required: ['query'],
            },
          }],
        },
        {
          serverId: 'unsafe',
          serverName: 'Unsafe MCP',
          tools: [{ name: 'delete_contacts', annotations: { readOnlyHint: true } }],
        },
      ],
      callTool: jest.fn().mockResolvedValue({
        structuredContent: {
          contacts: [
            { id: 'contact-1', name: 'Asha', email: 'asha@example.com' },
            { id: 'contact-2', name: 'Ravi', email: 'ravi@example.com' },
          ],
        },
      }),
    };
    const ai = { isEnabled: () => false, planResearchCalls: jest.fn() };
    const service = new ResearchService(registry as never, ai as never);

    const result = await service.run({ query: 'Find CRM contacts', maxRecords: 10, maxTools: 5 });

    expect(registry.callTool).toHaveBeenCalledTimes(1);
    expect(registry.callTool).toHaveBeenCalledWith('crm', 'search_contacts', { query: 'Find CRM contacts', limit: 10 });
    expect(result.records).toHaveLength(2);
    expect(result.records[0].serverId).toBe('crm');
    expect(result.report.successfulCalls).toBe(1);
    expect(result.report.rawRecords).toBe(2);
    expect(result.report.uniqueRecords).toBe(2);
  });

  it('includes configured but disconnected connectors in the execution report', async () => {
    const registry = {
      getStatuses: () => [
        { id: 'online', name: 'Online source', enabled: true, connected: true },
        { id: 'offline', name: 'Offline source', enabled: true, connected: false, error: 'Connection refused' },
      ],
      getToolCatalog: () => [{
        serverId: 'online',
        serverName: 'Online source',
        tools: [{ name: 'search_records', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      }],
      callTool: jest.fn().mockResolvedValue({ structuredContent: { records: [{ id: 'one', title: 'Result' }] } }),
    };
    const ai = { isEnabled: () => false };
    const service = new ResearchService(registry as never, ai as never);
    const result = await service.run({ query: 'Search records', maxRecords: 10, maxTools: 5 });
    expect(result.report.configuredServers).toBe(2);
    expect(result.report.connectedServers).toBe(1);
    expect(result.report.selectedServers).toBe(2);
    expect(result.report.selectedConnectedServers).toBe(1);
    expect(result.report.perConnector).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverId: 'offline', connected: false, connectionError: 'Connection refused', callsSucceeded: 0 }),
    ]));
  });

  it('runs focused India job searches and returns structured, evidence-backed hiring records', async () => {
    const jobUrl = 'https://careers.example.in/jobs/java-backend-engineer';
    const registry = {
      getStatuses: () => [{ id: 'serper-research', name: 'Public web research', enabled: true, connected: true }],
      getToolCatalog: () => [{
        serverId: 'serper-research',
        serverName: 'Public web research',
        tools: [{
          name: 'search_web',
          description: 'Search Google and crawl public job pages',
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              queries: { type: 'array', items: { type: 'string' } },
              limit: { type: 'integer' },
              country: { type: 'string' },
              crawlPages: { type: 'boolean' },
            },
            required: ['query'],
          },
        }],
      }],
      callTool: jest.fn().mockResolvedValue({
        structuredContent: {
          records: [{
            id: jobUrl,
            title: 'Java Backend Engineer',
            url: jobUrl,
            pageTitle: 'Java Backend Engineer - Example Technologies',
            jobPostings: [{
              title: 'Java Backend Engineer',
              company: 'Example Technologies',
              hiringOrganization: { name: 'Example Technologies' },
              location: 'Bengaluru, Karnataka',
              experienceRequirements: '3+ years',
              datePosted: '2026-10-20',
              employmentType: 'FULL_TIME',
              url: jobUrl,
            }],
            careerPageLinks: ['https://careers.example.in/careers'],
          }],
        },
      }),
    };
    const ai = { isEnabled: () => false };
    const service = new ResearchService(registry as never, ai as never);

    const result = await service.run({
      query: 'Find 100 Indian IT companies currently hiring Java developers',
      maxRecords: 100,
      maxTools: 10,
    });

    expect(registry.callTool).toHaveBeenCalledWith('serper-research', 'search_web', expect.objectContaining({
      query: 'Find 100 Indian IT companies currently hiring Java developers',
      queries: expect.arrayContaining([
        '"Java developer" India jobs careers',
        'site:boards.greenhouse.io "Java developer" India',
      ]),
      limit: 100,
      country: 'IN',
      crawlPages: true,
    }));
    expect(result.hiringResearch).toMatchObject({
      uniqueCompanies: 1,
      jobs: [{
        company: 'Example Technologies',
        position: 'Java Backend Engineer',
        location: 'Bengaluru, Karnataka',
        experience: '3+ years',
        careerPageUrl: 'https://careers.example.in/careers',
        jobUrl,
        postedAt: '2026-10-20',
        employmentType: 'FULL_TIME',
      }],
    });
  });

  it('does not collide identical provider IDs from different MCP servers when no URL is present', async () => {
    const registry = {
      getStatuses: () => [],
      getToolCatalog: () => ['source-a', 'source-b'].map((serverId) => ({
        serverId,
        serverName: serverId,
        tools: [{ name: 'search_records', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
      })),
      callTool: jest.fn().mockResolvedValue({ structuredContent: { records: [{ id: '42' }] } }),
    };
    const ai = { isEnabled: () => false };
    const service = new ResearchService(registry as never, ai as never);
    const result = await service.run({ query: 'Search records', maxRecords: 10, maxTools: 5 });
    expect(result.records).toHaveLength(2);
    expect(result.report.duplicatesRemoved).toBe(0);
  });

  it('deduplicates repeated real records returned by different MCP tools', async () => {
    const shared = { id: 'record-1', title: 'Senior Engineer', url: 'https://example.com/jobs/1' };
    const registry = {
      getStatuses: () => [],
      getToolCatalog: () => [{
        serverId: 'source-a',
        serverName: 'Source A',
        tools: [
          { name: 'search_jobs', description: 'Search jobs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          { name: 'list_jobs', description: 'List jobs', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
        ],
      }],
      callTool: jest.fn().mockResolvedValue({ structuredContent: { records: [shared] } }),
    };
    const ai = { isEnabled: () => false };
    const service = new ResearchService(registry as never, ai as never);

    const result = await service.run({ query: 'Search engineering jobs', maxRecords: 10, maxTools: 2 });

    expect(registry.callTool).toHaveBeenCalledTimes(2);
    expect(result.report.rawRecords).toBe(2);
    expect(result.report.uniqueRecords).toBe(1);
    expect(result.report.duplicatesRemoved).toBe(1);
  });
});
