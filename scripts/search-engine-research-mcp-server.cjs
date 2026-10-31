'use strict';

const readline = require('node:readline');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'NvoidResearchBot/1.0 (+https://jobkar.in; public research crawler)';

function integerEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function privateAddress(value) {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (family === 6) {
    return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')
      || address.startsWith('fe80:') || address.startsWith('ff') || address.startsWith('2001:db8:')
      || address.startsWith('::ffff:');
  }
  return family === 0;
}

async function publicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid absolute URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP(S) URLs without embedded credentials can be crawled.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Private and local hostnames are blocked.');
  }
  if (isIP(host)) {
    if (privateAddress(host)) throw new Error('Private or reserved IP addresses are blocked.');
    return url;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('Hostname could not be resolved.');
  }
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) {
    throw new Error('Private, reserved or link-local destination was blocked.');
  }
  return url;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(code, 16))));
}

function htmlText(html) {
  return decodeHtml(String(html || '')
    .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(header|footer|nav)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[\t\r\f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function flattenJsonLd(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const record = value;
  output.push(record);
  if (Array.isArray(record['@graph'])) flattenJsonLd(record['@graph'], output);
  return output;
}

function parseJobPostings(html, pageUrl) {
  const nodes = [];
  const scripts = String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      nodes.push(...flattenJsonLd(JSON.parse(match[1])));
    } catch {
      continue;
    }
  }
  const cleanField = (value, max = 1600) => {
    if (typeof value !== 'string') return '';
    return htmlText(value).slice(0, max);
  };
  const structuredText = (value, depth = 0) => {
    if (depth > 3 || value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') return cleanField(String(value), 800);
    if (Array.isArray(value)) return value.map((item) => structuredText(item, depth + 1)).filter(Boolean).join('; ').slice(0, 800);
    if (typeof value === 'object') {
      return Object.entries(value)
        .filter(([key]) => key !== '@type' && key !== '@id')
        .map(([key, item]) => {
          const text = structuredText(item, depth + 1);
          return text ? key + ': ' + text : '';
        })
        .filter(Boolean).join('; ').slice(0, 800);
    }
    return '';
  };
  const locationsFrom = (value) => {
    const locations = Array.isArray(value) ? value : value ? [value] : [];
    return locations.map((item) => {
      if (!item || typeof item !== 'object') return '';
      const address = item.address && typeof item.address === 'object' ? item.address : item;
      return [address.addressLocality, address.addressRegion, address.addressCountry]
        .map((part) => typeof part === 'string' ? part : part?.name || '')
        .filter(Boolean).join(', ');
    }).filter(Boolean).slice(0, 8);
  };
  return nodes.flatMap((node) => {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (!types.some((type) => String(type || '').toLowerCase() === 'jobposting')) return [];
    const organization = node.hiringOrganization && typeof node.hiringOrganization === 'object'
      ? node.hiringOrganization : {};
    const mainEntity = node.mainEntityOfPage;
    const url = typeof node.url === 'string' ? node.url
      : typeof mainEntity === 'string' ? mainEntity
        : mainEntity && typeof mainEntity === 'object' && typeof mainEntity['@id'] === 'string' ? mainEntity['@id'] : pageUrl;
    const location = locationsFrom(node.jobLocation);
    const experience = structuredText(node.experienceRequirements || node.experienceInPlaceOfEducation || node.qualifications);
    const validThrough = cleanField(node.validThrough, 80);
    if (!cleanField(node.title || node.name, 220) || !cleanField(organization.name, 180)) return [];
    return [{
      title: cleanField(node.title || node.name, 220),
      company: cleanField(organization.name, 180),
      hiringOrganization: { name: cleanField(organization.name, 180) },
      ...(location.length ? { location: location.join(' · '), locations: location } : {}),
      ...(experience ? { experienceRequirements: experience } : {}),
      ...(cleanField(node.description, 5000) ? { description: cleanField(node.description, 5000) } : {}),
      ...(cleanField(node.datePosted, 80) ? { datePosted: cleanField(node.datePosted, 80) } : {}),
      ...(validThrough ? { validThrough } : {}),
      ...(structuredText(node.employmentType) ? { employmentType: structuredText(node.employmentType).slice(0, 100) } : {}),
      url: (() => { try { return new URL(url, pageUrl).href; } catch { return pageUrl; } })(),
    }];
  }).slice(0, 30);
}

function extractCareerPageLinks(html, pageUrl) {
  const base = new URL(pageUrl);
  const links = new Set();
  const anchors = String(html || '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const match of anchors) {
    const href = decodeHtml(match[1]).trim();
    const label = htmlText(match[2]).slice(0, 180);
    if (!/career|jobs?|openings?|vacanc|join our team|work with us/i.test(href + ' ' + label)) continue;
    try {
      const url = new URL(href, base);
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
      url.hash = '';
      links.add(url.href);
    } catch {
      continue;
    }
    if (links.size >= 12) break;
  }
  return [...links];
}

function extractPage(html, url) {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '').trim();
  const descriptionMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  const canonicalMatch = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i);
  const canonical = canonicalMatch?.[1] ? new URL(decodeHtml(canonicalMatch[1]), url).href : url;
  const text = htmlText(html);
  const jobPostings = parseJobPostings(html, canonical);
  const careerPageLinks = extractCareerPageLinks(html, canonical);
  return {
    pageTitle: title.slice(0, 500),
    pageDescription: decodeHtml(descriptionMatch?.[1] || '').slice(0, 1500),
    canonicalUrl: canonical,
    ...(jobPostings.length ? { jobPostings } : {}),
    ...(careerPageLinks.length ? { careerPageLinks } : {}),
    pageText: text.slice(0, 12000),
    pageTextTruncated: text.length > 12000,
  };
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Page exceeds the public crawl size limit.');
      }
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function fetchPublicPage(rawUrl) {
  let current = await publicUrl(rawUrl);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.3', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(9000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      if (!next) throw new Error('Redirect response did not include a location.');
      current = await publicUrl(new URL(next, current).href);
      continue;
    }
    if (!response.ok) throw new Error('Page fetch returned HTTP ' + response.status + '.');
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('html') && !contentType.includes('xhtml') && !contentType.includes('text/plain')) {
      throw new Error('Unsupported page content type: ' + contentType.split(';')[0]);
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_BODY_BYTES) throw new Error('Page exceeds the public crawl size limit.');
    const html = await readTextLimited(response, MAX_BODY_BYTES);
    return { ...extractPage(html, current.href), finalUrl: current.href, httpStatus: response.status, contentType };
  }
  throw new Error('Too many redirects.');
}

async function runConcurrent(items, concurrency, operation) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        result[index] = await operation(items[index], index);
      } catch (error) {
        result[index] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
  }));
  return result;
}

function normalizeOrganic(items, query) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item, index) => {
    let url;
    try {
      url = new URL(item.link || item.url);
      if (!['http:', 'https:'].includes(url.protocol)) return [];
      url.hash = '';
    } catch {
      return [];
    }
    const key = url.href.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: key,
      title: String(item.title || '').slice(0, 500),
      url: url.href,
      snippet: String(item.snippet || '').slice(0, 3000),
      publishedDate: String(item.date || item.page_age || ''),
      position: Number(item.position || index + 1),
      domain: url.hostname,
      searchQuery: String(item._nvoidSearchQuery || query),
      source: 'Serper Google Search',
      crawled: false,
    }];
  });
}

function buildDorkQueries(query) {
  const phrase = String(query || '').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!phrase || /\b(site|inurl|intitle|filetype|before|after):/i.test(phrase)) return [];
  const words = phrase.split(/\s+/).filter((word) => word.length > 2 && !/^(the|and|for|with|from|into|near|around|about)$/i.test(word));
  if (words.length === 0) return [];
  const lead = words.slice(0, 3).join(' ');
  const variants = [
    '"' + phrase + '"',
    'intitle:"' + lead + '"',
    'inurl:' + words[0].toLowerCase() + ' "' + phrase + '"',
    'filetype:pdf "' + phrase + '"',
  ];
  if (/\b(job|jobs|hiring|career|vacanc(?:y|ies)|recruitment|opening|employment)\b/i.test(phrase)) {
    variants.push('site:linkedin.com/jobs "' + phrase + '"');
    variants.push('site:naukri.com "' + phrase + '"');
  }
  return [...new Set(variants)].filter((value) => value.toLowerCase() !== String(query).trim().toLowerCase()).slice(0, 7);
}

async function searchWeb(args) {
  const query = String(args.query || '').trim();
  if (query.length < 3) throw new Error('A research query of at least three characters is required.');
  const apiKey = String(process.env.SERPER_API_KEY || '').trim();
  if (!apiKey || apiKey.includes('${')) throw new Error('Set SERPER_API_KEY in the worker .env to enable public web research.');
  const limit = Math.min(1000, Math.max(1, Number.parseInt(args.limit, 10) || 100));
  const requestedVariants = Array.isArray(args.queries) ? args.queries : [];
  const queries = [...new Set([query, ...requestedVariants
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length >= 3),
    ...buildDorkQueries(query),
  ])].slice(0, 8);
  const pageLimit = integerEnv('NVOID_WEB_SEARCH_MAX_PAGES', 10, 1, 30);
  const pagesPerQuery = Math.min(pageLimit, Math.ceil(limit / 10));
  const configuredMaxRequests = integerEnv('NVOID_WEB_SEARCH_MAX_REQUESTS', 30, 1, 240);
  const hiringSearch = /\\b(hiring|hire|recruit(?:ing|ment)?|job openings?|open positions?|vacanc(?:y|ies)|careers?)\\b/i.test(query);
  const maxRequests = Math.min(configuredMaxRequests, hiringSearch ? 12 : 30);
  const requestedPages = Array.from({ length: pagesPerQuery }, (_, page) =>
    queries.map((searchQuery) => ({ query: searchQuery, page: page + 1 })),
  ).flat();
  const requests = requestedPages.slice(0, maxRequests);
  const country = String(args.country || 'IN').toLowerCase().slice(0, 2);
  const pageResponses = await runConcurrent(requests, 6, async (request) => {
    try {
      const response = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'X-API-KEY': apiKey, 'user-agent': USER_AGENT },
        body: JSON.stringify({ q: request.query, gl: country, hl: 'en', num: 10, page: request.page }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) return { ...request, error: 'Serper returned HTTP ' + response.status + '. Check the API key, credits and rate limits.' };
      return { ...request, data: await response.json() };
    } catch (error) {
      return { ...request, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const searchErrors = pageResponses.filter((item) => item?.error);
  const organic = pageResponses.flatMap((item) => Array.isArray(item?.data?.organic)
    ? item.data.organic.map((result) => ({ ...result, _nvoidSearchQuery: item.query }))
    : []);
  const candidates = normalizeOrganic(organic, query).slice(0, limit);
  const crawlEnabled = args.crawlPages !== false;
  const configuredCrawlBudget = integerEnv('NVOID_WEB_CRAWL_MAX_PAGES', 25, 0, 100);
  const crawlBudget = hiringSearch ? Math.min(configuredCrawlBudget, 16) : configuredCrawlBudget;
  const crawlCount = crawlEnabled ? Math.min(crawlBudget, candidates.length) : 0;
  const fetched = await runConcurrent(candidates.slice(0, crawlCount), Math.min(12, Math.max(integerEnv('NVOID_WEB_CRAWL_CONCURRENCY', 6, 1, 12), hiringSearch ? 8 : 6)), async (candidate) => fetchPublicPage(candidate.url));
  const fetchErrors = [];
  let pagesFetched = 0;
  const records = candidates.map((candidate, index) => {
    const page = fetched[index];
    if (page && !page.error) {
      pagesFetched += 1;
      return { ...candidate, ...page, crawled: true };
    }
    if (page?.error) fetchErrors.push({ url: candidate.url, error: page.error });
    return candidate;
  });
  const requestBudgetReached = requestedPages.length > requests.length;
  const providerResultCapReached = candidates.length >= Math.min(limit, (requests.length - searchErrors.length) * 10) && candidates.length < limit;
  const crawlBudgetReached = crawlEnabled && candidates.length > crawlCount;
  return {
    records,
    searchReport: {
      provider: 'Serper Google Search API',
      query,
      searchQueries: queries,
      searchQueriesRequested: queries.length,
      searchRequestsRequested: requestedPages.length,
      searchRequestsExecuted: requests.length,
      searchRequestsSucceeded: requests.length - searchErrors.length,
      failedSearchRequests: searchErrors.length,
      searchRequestErrors: searchErrors.slice(0, 30).map((item) => ({ query: item.query, page: item.page, error: item.error })),
      indexedResults: organic.length,
      uniqueSearchResults: candidates.length,
      publicPagesAvailable: candidates.length,
      publicPagesAttempted: crawlCount,
      publicPagesFetched: pagesFetched,
      publicPagesNotAttempted: crawlEnabled ? Math.max(0, candidates.length - crawlCount) : 0,
      crawlBudgetReached,
      failedPageFetches: fetchErrors.length,
      pageFetchErrors: fetchErrors.slice(0, 30),
      recordLimit: limit,
      requestBudgetReached,
      providerResultCapReached,
      truncated: requestBudgetReached || providerResultCapReached || searchErrors.length > 0 || crawlBudgetReached,
    },
  };
}
const tools = [{
  name: 'search_web',
  description: 'Search the public web through Google-indexed results with support for Google dork operators such as site:, inurl:, intitle:, exact phrases and OR. Paginates results and enriches results by fetching accessible public HTML/text pages. Returns actual URLs, snippets, titles, page metadata and extracted page text. Does not log in, bypass access controls or crawl private networks.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Original research question or primary Google query including dork operators.' },
      queries: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Optional complementary query variants, including focused Google dork operators, for wider coverage.' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum unique search result records to return.' },
      country: { type: 'string', description: 'Two-letter country code for regional search.' },
      crawlPages: { type: 'boolean', description: 'Fetch and extract publicly accessible result pages. Defaults to true.' },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}];

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const id = message.id;
  if (id === undefined || id === null || message.method.startsWith('notifications/')) return;
  if (message.method === 'initialize') {
    send(id, { protocolVersion: message.params?.protocolVersion || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nvoid-public-web-research', version: '1.0.0' } });
    return;
  }
  if (message.method === 'ping') return send(id, {});
  if (message.method === 'tools/list') return send(id, { tools });
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'search_web') return sendError(id, -32602, 'Unknown tool.');
    try {
      const value = await searchWeb(message.params?.arguments || {});
      const structuredContent = { ...value, returnedCount: value.records.length };
      const envelope = {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent,
          isError: false,
        },
      };
      process.stdout.write(JSON.stringify(envelope) + '\n');
    } catch (error) {
      sendError(id, -32000, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  sendError(id, -32601, 'Unsupported method.');
}

function start() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    try {
      void handle(JSON.parse(line)).catch((error) => process.stderr.write(String(error) + '\n'));
    } catch {
      process.stderr.write('Ignored invalid MCP JSON.\n');
    }
  });
}

if (require.main === module) start();
module.exports = { searchWeb, normalizeOrganic, extractPage, htmlText, publicUrl, buildDorkQueries };
