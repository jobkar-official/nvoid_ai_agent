const crawler = require('../../scripts/search-engine-jobs-mcp-server.cjs') as {
  buildSearchQueries: (profile: Record<string, unknown>) => string[];
  family: (value: string) => string | undefined;
  matchesRole: (title: string, description: string, query: string) => boolean;
  locationMatch: (location: string, description: string, url: string, requested: string) => boolean;
  safeUrl: (url: string) => URL | undefined;
  isJobUrl: (url: string) => boolean;
  parsePage: (html: string, url: string) => { title: string; description: string; canonicalUrl: string; postings: Array<Record<string, unknown>> };
};
describe('search-engine job crawler', () => {
  it('creates role/location dork queries across job boards and ATS platforms', () => {
    const queries = crawler.buildSearchQueries({ query: 'Java Developer', location: 'Bengaluru, India', skills: ['Java', 'Spring Boot'] });
    expect(queries.some((q) => q.includes('site:naukri.com/job-listings'))).toBe(true);
    expect(queries.some((q) => q.includes('site:boards.greenhouse.io'))).toBe(true);
    expect(queries.every((q) => q.includes('Java Developer'))).toBe(true);
    expect(queries.some((q) => q.includes('Bengaluru, India'))).toBe(true);
  });
  it('separates role families and specific technologies', () => {
    expect(crawler.family('Software Developer')).toBe('software');
    expect(crawler.matchesRole('Senior Java Developer', '', 'Java Developer')).toBe(true);
    expect(crawler.matchesRole('Python Developer', 'Python Django', 'Java Developer')).toBe(false);
    expect(crawler.matchesRole('DevOps Engineer', 'Kubernetes', 'Software Developer')).toBe(false);
  });
  it('requires relevant location evidence for city-specific searches', () => {
    expect(crawler.locationMatch('Bengaluru, India', '', 'https://careers.example.com/jobs/1', 'Bengaluru')).toBe(true);
    expect(crawler.locationMatch('Remote India', 'Candidates located in India', 'https://jobs.example.com/jobs/1', 'Bengaluru')).toBe(true);
    expect(crawler.locationMatch('Remote · eligibility not stated', 'Remote team', 'https://jobs.example.com/jobs/1', 'Bengaluru')).toBe(false);
    expect(crawler.locationMatch('Remote United States', 'US only', 'https://jobs.example.com/jobs/1', 'Bengaluru')).toBe(false);
    expect(crawler.locationMatch('Pune, India', 'On-site role', 'https://jobs.example.com/jobs/1', 'Bengaluru, India')).toBe(false);
  });
  it('recognizes public job URLs and rejects unsafe URLs', () => {
    expect(crawler.isJobUrl('https://jobs.lever.co/acme/123')).toBe(true);
    expect(crawler.isJobUrl('https://www.naukri.com/job-listings-java-developer-123')).toBe(true);
    expect(crawler.isJobUrl('https://example.com/about')).toBe(false);
    expect(crawler.safeUrl('http://127.0.0.1/admin')).toBeUndefined();
    expect(crawler.safeUrl('file:///etc/passwd')).toBeUndefined();
  });
  it('extracts schema.org JobPosting structured data', () => {
    const html = '<html><head><title>Java Developer - Acme</title><meta name="description" content="Java role in Bengaluru"></head><body><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Java Developer","hiringOrganization":{"@type":"Organization","name":"Acme"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Bengaluru","addressCountry":"India"}},"description":"Build Java services"}</script></body></html>';
    const page = crawler.parsePage(html, 'https://jobs.lever.co/acme/123');
    expect(page.title).toBe('Java Developer - Acme');
    expect(page.postings).toHaveLength(1);
    expect(page.postings[0].title).toBe('Java Developer');
  });
});
