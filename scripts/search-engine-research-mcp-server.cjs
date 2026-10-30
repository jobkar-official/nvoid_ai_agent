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

function extractPage(html, url) {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '').trim();
  const descriptionMatch = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i);
  const canonicalMatch = html.match(/<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i)
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["']/i);
  const canonical = canonicalMatch?.[1] ? new URL(decodeHtml(canonicalMatch[1]), url).href : url;
  const text = htmlText(html);
  return {
    pageTitle: title.slice(0, 500),
    pageDescription: decodeHtml(descriptionMatch?.[1] || '').slice(0, 1500),
    canonicalUrl: canonical,
    pageText: text.slice(0, 12000),
    pageTextTruncated: text.length > 12000,
  };
}

async function fetchPublicPage(rawUrl) {
  let current = await publicUrl(rawUrl);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.3', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(12000),
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
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_BODY_BYTES) throw new Error('Page exceeds the public crawl size limit.');
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
      searchQuery: query,
      source: 'Serper Google Search',
      crawled: false,
    }];
  });
}

async function searchWeb(args) {
  const query = String(args.query || '').trim();
  if (query.length < 3) throw new Error('A research query of at least three characters is required.');
  const apiKey = String(process.env.SERPER_API_KEY || '').trim();
  if (!apiKey || apiKey.includes('${')) throw new Error('Set SERPER_API_KEY in the worker .env to enable public web research.');
  const limit = Math.min(1000, Math.max(1, Number.parseInt(args.limit, 10) || 100));
  const pageLimit = integerEnv('NVOID_WEB_SEARCH_MAX_PAGES', 10, 1, 30);
  const pages = Math.min(pageLimit, Math.ceil(limit / 10));
  const country = String(args.country || 'IN').toLowerCase().slice(0, 2);
  const pageResponses = await runConcurrent(Array.from({ length: pages }, (_, page) => page), 5, async (page) => {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'X-API-KEY': apiKey, 'user-agent': USER_AGENT },
      body: JSON.stringify({ q: query, gl: country, hl: 'en', num: 10, page: page + 1 }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Serper returned HTTP ' + response.status + '. Check the API key, credits and rate limits.');
    return response.json();
  });
  const searchErrors = pageResponses.filter((item) => item?.error);
  const organic = pageResponses.flatMap((item) => Array.isArray(item?.organic) ? item.organic : []);
  const candidates = normalizeOrganic(organic, query).slice(0, limit);
  const crawlEnabled = args.crawlPages !== false;
  const crawlBudget = integerEnv('NVOID_WEB_CRAWL_MAX_PAGES', 25, 0, 100);
  const crawlCount = crawlEnabled ? Math.min(crawlBudget, candidates.length) : 0;
  const fetched = await runConcurrent(candidates.slice(0, crawlCount), integerEnv('NVOID_WEB_CRAWL_CONCURRENCY', 6, 1, 12), async (candidate) => fetchPublicPage(candidate.url));
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
  return {
    records,
    searchReport: {
      provider: 'Serper Google Search API',
      query,
      pagesRequested: pages,
      pagesSucceeded: pages - searchErrors.length,
      failedSearchPages: searchErrors.length,
      indexedResults: organic.length,
      uniqueSearchResults: candidates.length,
      publicPagesAttempted: crawlCount,
      publicPagesFetched: pagesFetched,
      failedPageFetches: fetchErrors.length,
      pageFetchErrors: fetchErrors.slice(0, 30),
      recordLimit: limit,
      providerPageBudgetReached: pages >= pageLimit && candidates.length >= pages * 10 && candidates.length < limit,
      truncated: candidates.length >= pages * 10 && candidates.length < limit,
    },
  };
}

const tools = [{
  name: 'search_web',
  description: 'Search the public web through Google-indexed results with support for Google dork operators such as site:, inurl:, intitle:, exact phrases and OR. Paginates results and enriches results by fetching accessible public HTML/text pages. Returns actual URLs, snippets, titles, page metadata and extracted page text. Does not log in, bypass access controls or crawl private networks.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language query or a complete Google query including dork operators.' },
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
      send(id, {
        result: undefined,
      });
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
module.exports = { searchWeb, normalizeOrganic, extractPage, htmlText, publicUrl };
