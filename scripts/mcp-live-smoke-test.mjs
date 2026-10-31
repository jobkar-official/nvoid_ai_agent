import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = process.cwd();
const configPath = path.join(root, 'config', 'mcp-servers.json');
const configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const query = process.argv[2] || 'Software Developer';
const location = process.argv[3] || 'Bengaluru';
const limit = Math.max(1, Math.min(50, Number(process.env.NVOID_MCP_SMOKE_LIMIT || 20)));
const countries = /india|bengaluru|bangalore|delhi|noida|gurugram|mumbai|hyderabad|chennai|pune/i.test(location) ? ['India'] : [];
const profile = {
  jobTitle: query,
  location,
  countries,
  skills: (process.env.NVOID_SEARCH_SKILLS || '').split(',').map(value => value.trim()).filter(Boolean),
  keywords: [],
  remote: process.env.NVOID_SEARCH_REMOTE === 'true',
};

function expandEnv(value) {
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnv(child)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key) => process.env[key] || '');
}

function resolveTemplate(value) {
  if (Array.isArray(value)) return value.map(resolveTemplate).filter(item => item !== undefined);
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$profile === 'string') return profile[value.$profile];
    if (Object.keys(value).length === 1 && value.$context === 'limit') return limit;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveTemplate(child)]).filter(([, child]) => child !== undefined));
  }
  if (typeof value === 'string') {
    const exact = /^\{\{profile\.([a-zA-Z0-9_]+)\}\}$/.exec(value);
    if (exact) return profile[exact[1]];
    if (value === '{{limit}}') return limit;
    return value.replace(/\{\{profile\.([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
      const item = profile[key];
      return Array.isArray(item) ? item.join(', ') : item === undefined || item === null ? '' : String(item);
    });
  }
  return value;
}

function countryForProfile() {
  return countries[0] || location;
}

function isSearchTool(tool) {
  const identity = (tool.name + ' ' + (tool.description || '')).toLowerCase();
  return /(search|find|list|discover|fetch|query).{0,45}(jobs?|vacanc(?:y|ies)|open.?roles?|positions?|opportunit(?:y|ies)|recruitment)|(jobs?|vacanc(?:y|ies)|open.?roles?|positions?|opportunit(?:y|ies)|recruitment).{0,45}(search|find|list|discover|fetch|query)|\bget[_\s-]?(jobs?|vacanc(?:y|ies)|open.?roles?|positions?|opportunit(?:y|ies))\b/i.test(identity)
    && !/(apply|submit|application|delete|remove|update|create|detail|details|profile|company_profile|_by_company|similar|related)/i.test(tool.name)
    && tool.annotations?.destructiveHint !== true;
}

function inferArguments(tool) {
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  if (!Object.keys(properties).length) return undefined;
  const args = {};
  const missing = [];
  for (const [name, metadata] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let value;
    if (/^(q|kw|query|querytext|keyword|search|searchtext|searchterm|searchquery|term|jobtitle|title|position|role|jobname)$/.test(compact)) value = query;
    else if (/^(keywords|skills|skill|technologies|techstack)$/.test(compact)) value = metadata.type === 'array' ? profile.skills : profile.skills.join(', ');
    else if (/^(loc|location|locationname|city|cityname|region|geo|geography|place|joblocation|preferredlocation)$/.test(compact)) value = location;
    else if (compact === 'country') value = countryForProfile();
    else if (compact === 'countries') value = metadata.type === 'array' ? countries : countries.join(',');
    else if (compact === 'countryindeed') value = countries[0] || 'India';
    else if (/^(limit|count|n|resultswanted|perpage|pagesize|maxresults|take)$/.test(compact)) value = limit;
    else if (compact === 'page') value = 1;
    else if (compact === 'start' || compact === 'offset') value = 0;
    else if (compact === 'remote' || compact === 'isremote' || compact === 'remoteonly') value = profile.remote ? true : undefined;
    else if (compact === 'workplace') value = profile.remote ? 'remote' : undefined;
    else if (compact === 'worldwide') value = false;
    else if (compact === 'postedwithin' && Array.isArray(metadata.enum)) value = metadata.enum.includes('Past month') ? 'Past month' : metadata.enum[0];
    else if (compact === 'age') value = 'r2592000';
    else if (compact === 'sort') value = Array.isArray(metadata.enum) && metadata.enum.includes('recent') ? 'recent' : undefined;
    if (value !== undefined) args[name] = metadata.type === 'array' && !Array.isArray(value) ? [value] : value;
    else if ((schema.required || []).includes(name)) missing.push(name);
  }
  return missing.length ? undefined : args;
}

function isJobDetailTool(name) {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized === 'get_job'
    || /(?:^|_)get_job_details?$/.test(normalized)
    || /(?:^|_)(?:fetch|retrieve)_job_details?$/.test(normalized)
    || /(?:^|_)job_details?$/.test(normalized);
}

function extractRecords(value, records = [], depth = 0) {
  if (depth > 10 || value === null || value === undefined) return records;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return records;
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try { extractRecords(JSON.parse(text), records, depth + 1); } catch {}
    } else {
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*\d+\.\s+\*\*(.+?)\*\*\s+at\s+(.+?)\s*$/.exec(line);
        if (match) records.push({ title: match[1], company: match[2] });
      }
    }
    return records;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractRecords(item, records, depth + 1);
    return records;
  }
  if (typeof value !== 'object') return records;
  const object = value;
  if (['title', 'jobtitle', 'job_title', 'position', 'role', 'name', 't'].some(key => Object.keys(object).some(item => item.toLowerCase() === key))) {
    records.push(object);
    return records;
  }
  const preferred = ['structuredContent', 'jobs', 'results', 'items', 'data', 'job_list', 'opportunities', 'records', 'content', 'text', 'output'];
  let traversed = false;
  for (const key of preferred) {
    if (key in object) {
      extractRecords(object[key], records, depth + 1);
      traversed = true;
    }
  }
  if (!traversed) for (const child of Object.values(object)) {
    if (child && (Array.isArray(child) || typeof child === 'object' || typeof child === 'string')) extractRecords(child, records, depth + 1);
  }
  return records;
}

function detailArguments(tool, job, searchId) {
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  const args = {};
  const missing = [];
  const company = job.company && typeof job.company === 'object' ? job.company : {};
  const jobId = job.id ?? job.job_id ?? job.job_handle ?? job.jobHandle ?? job.key ?? job.slug;
  const jobSlug = job.job_slug ?? job.jobSlug ?? job.slug ?? jobId;
  const companySlug = job.company_slug ?? job.companySlug ?? company.slug;
  for (const [name, metadata] of Object.entries(properties)) {
    const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let value;
    if (compact === 'searchid' || compact === 'searchidentifier') value = searchId;
    else if (compact === 'jobids' || compact === 'ids') value = jobId === undefined ? undefined : [String(jobId)];
    else if (compact === 'companyslug') value = companySlug;
    else if (compact === 'jobslug') value = jobSlug;
    else if (/^(id|jobid|jobkey|jobhandle|key|jobcode|slug|jobidentifier|idorslug|jobidorslug)$/.test(compact)) value = jobId ?? jobSlug;
    else if (/^(url|joburl|jobpostingurl|postingurl|link)$/.test(compact)) value = job.url ?? job.job_url ?? job.jobUrl;
    if (value !== undefined) args[name] = metadata.type === 'array' && !Array.isArray(value) ? [value] : value;
    else if ((schema.required || []).includes(name)) missing.push(name);
  }
  return missing.length ? undefined : args;
}

async function connect(server) {
  const expanded = expandEnv(server);
  if (JSON.stringify(expanded).match(/\$\{[A-Z0-9_]+\}/)) throw new Error('Unresolved environment variable in MCP configuration');
  const client = new Client({ name: 'nvoid-live-mcp-verifier', version: '1.0.0' });
  let transport;
  if (expanded.transport === 'http') {
    transport = new StreamableHTTPClientTransport(new URL(expanded.url), { requestInit: { headers: expanded.headers || {} } });
  } else if (expanded.transport === 'sse') {
    transport = new SSEClientTransport(new URL(expanded.url), { requestInit: { headers: expanded.headers || {} } });
  } else {
    const env = Object.fromEntries(Object.entries({ ...process.env, ...(expanded.env || {}) }).filter(([, value]) => typeof value === 'string'));
    transport = new StdioClientTransport({ command: expanded.command, args: expanded.args || [], cwd: expanded.cwd || root, env });
  }
  await client.connect(transport);
  return client;
}

const summary = [];
for (const server of configs.filter(item => item.enabled)) {
  const row = { server: server.id, connected: false, tools: 0, searched: 0, jobs: 0, details: 0, errors: [] };
  let client;
  try {
    client = await connect(server);
    row.connected = true;
    const listed = await client.listTools();
    row.tools = listed.tools.length;
    const searchTools = listed.tools.filter(isSearchTool);
    const preferred = server.jobSearch?.tool;
    searchTools.sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred));
    if (!searchTools.length) row.errors.push('Connected, but no job-search tool was discovered.');
    for (const tool of searchTools) {
      const configured = tool.name === preferred && server.jobSearch?.arguments;
      let args = configured ? resolveTemplate(server.jobSearch.arguments) : inferArguments(tool);
      if (args === undefined) {
        row.errors.push(tool.name + ': required search parameters could not be inferred; likely company-specific search.');
        continue;
      }
      if (server.id === 'jobicy') args = { ...args, geo: args.geo || 'apac', limit: args.limit || limit };
      if (server.id === 'mcp-jobspy-speedyapply' && profile.remote) args.is_remote = true;
      if (server.id === 'himalayas-mcp' && countries.length) args.country = countries[0];
      if (server.id === 'aidevboard' && profile.remote) args.workplace = 'remote';
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
        if (result?.isError) throw new Error(JSON.stringify(result.content || 'MCP tool returned an error').slice(0, 500));
        const records = extractRecords(result);
        row.searched++;
        row.jobs += records.length;
        const searchId = result?.structuredContent?.search_id || result?.structuredContent?.searchId;
        const detailTool = listed.tools.find(item => isJobDetailTool(item.name));
        if (records.length && detailTool) {
          const detailArgs = detailArguments(detailTool, records[0], searchId);
          if (detailArgs) {
            try {
              const detailResult = await client.callTool({ name: detailTool.name, arguments: detailArgs });
              if (!detailResult?.isError) {
                const details = extractRecords(detailResult);
                const first = details[0] || detailResult?.structuredContent || {};
                if (first && typeof first === 'object' && (first.description || first.jobDescription || first.requirements)) row.details++;
              }
            } catch (error) {
              row.errors.push(detailTool.name + ': ' + (error instanceof Error ? error.message : String(error)).slice(0, 300));
            }
          }
        }
        process.stdout.write(JSON.stringify({ server: server.id, tool: tool.name, jobs: records.length, detailsVerified: row.details, args }) + '\n');
      } catch (error) {
        row.errors.push(tool.name + ': ' + (error instanceof Error ? error.message : String(error)).slice(0, 500));
        process.stdout.write(JSON.stringify({ server: server.id, tool: tool.name, error: row.errors[row.errors.length - 1] }) + '\n');
      }
    }
  } catch (error) {
    row.errors.push(error instanceof Error ? error.message : String(error));
    process.stdout.write(JSON.stringify({ server: server.id, connectionError: row.errors[row.errors.length - 1] }) + '\n');
  } finally {
    if (client) await client.close().catch(() => undefined);
  }
  summary.push(row);
}
process.stdout.write('\nLIVE MCP SUMMARY\n');
for (const row of summary) process.stdout.write(JSON.stringify(row) + '\n');
const totalJobs = summary.reduce((sum, row) => sum + row.jobs, 0);
const connected = summary.filter(row => row.connected).length;
process.exitCode = connected > 0 && totalJobs > 0 ? 0 : 1;
