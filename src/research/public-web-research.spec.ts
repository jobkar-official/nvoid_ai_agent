const {
  extractPage,
  htmlText,
  normalizeOrganic,
} = require('../../scripts/search-engine-research-mcp-server.cjs');

describe('public web research MCP crawler parsing', () => {
  it('normalizes real organic result fields and removes duplicate URLs', () => {
    const records = normalizeOrganic([
      { title: 'Company Careers', link: 'https://example.com/careers', snippet: 'Open roles' },
      { title: 'Duplicate', link: 'https://example.com/careers#jobs', snippet: 'Duplicate result' },
      { title: 'Research', link: 'https://example.org/research', snippet: 'Public page' },
    ], 'company careers');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      title: 'Company Careers',
      url: 'https://example.com/careers',
      searchQuery: 'company careers',
      source: 'Serper Google Search',
      crawled: false,
    });
  });

  it('retains the query variant that produced each public search record', () => {
    const records = normalizeOrganic([
      { title: 'Careers', link: 'https://example.com/jobs', _nvoidSearchQuery: 'site:example.com jobs' },
    ], 'original search');
    expect(records[0].searchQuery).toBe('site:example.com jobs');
  });

  it('extracts page title, metadata, canonical URL and readable page text', () => {
    const html = '<html><head><title>Research Page</title><meta name="description" content="A public description"><link rel="canonical" href="https://example.com/canonical"></head><body><script>secret()</script><h1>Public research</h1><p>Actual page content &amp; details.</p></body></html>';
    const page = extractPage(html, 'https://example.com/source');
    expect(page.pageTitle).toBe('Research Page');
    expect(page.pageDescription).toBe('A public description');
    expect(page.canonicalUrl).toBe('https://example.com/canonical');
    expect(page.pageText).toContain('Actual page content & details.');
    expect(page.pageText).not.toContain('secret');
  });

  it('strips scripts and normalizes page text without pretending it is structured data', () => {
    expect(htmlText('<p>One</p><script>bad()</script><p>Two</p>')).toBe('One Two');
  });
});
