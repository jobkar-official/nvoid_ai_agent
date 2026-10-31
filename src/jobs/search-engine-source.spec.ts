const crawler = require('../../scripts/search-engine-jobs-mcp-server.cjs') as {
  buildSearchQueries: (profile: Record<string, unknown>) => string[];
  family: (value: string) => string | undefined;
  matchesRole: (title: string, description: string, query: string) => boolean;
  locationMatch: (location: string, description: string, url: string, requested: string) => boolean;
  safeUrl: (url: string) => URL | undefined;
  isJobUrl: (url: string, evidence?: string) => boolean;
  parsePage: (html: string, url: string) => { title: string; description: string; canonicalUrl: string; postings: Array<Record<string, unknown>>; links: Array<{ url: string; text: string }> };
  normalizeSearchResponse: (data: Record<string, unknown>) => { results: Array<Record<string, unknown>>; more: boolean };
  atsBoardFromUrl: (url: string) => { provider: string; board: string } | undefined;
  mapAtsJob: (board: { provider: string; board: string }, job: Record<string, unknown>) => Record<string, unknown> | undefined;
};
describe('search-engine job crawler', () => {
  it('creates role/location dork queries across job boards and ATS platforms', () => {
    const queries = crawler.buildSearchQueries({ query: 'Java Developer', location: 'Bengaluru, India', skills: ['Java', 'Spring Boot'] });
    expect(queries.some((q) => q.includes('site:naukri.com'))).toBe(true);
    expect(queries.some((q) => q.includes('site:boards.greenhouse.io'))).toBe(true);
    expect(queries.every((q) => q.includes('Java'))).toBe(true);
    expect(queries.some((q) => q.includes('Bengaluru, India'))).toBe(true);
    expect(queries.some((q) => q.includes('site:cutshort.io'))).toBe(true);
    expect(queries.some((q) => q.includes('site:boards.greenhouse.io'))).toBe(true);
    expect(queries.some((q) => q.includes('site:gov.in'))).toBe(true);
    expect(queries.some((q) => q.includes('tender procurement RFP'))).toBe(true);
    const remoteQueries = crawler.buildSearchQueries({ query: 'Java Developer', location: 'Bengaluru, India', remote: true });
    expect(remoteQueries.some((q) => q.includes('remote work from anywhere'))).toBe(true);
  });
  it('includes validated LLM-proposed title variants in public-web searches', () => {
    const queries = crawler.buildSearchQueries({
      query: 'Software Developer',
      location: 'Bengaluru, India',
      titleVariants: ['Backend Developer', 'Software Development Engineer']
    });
    expect(queries.some((query) => query.includes('"Backend Developer"'))).toBe(true);
    expect(queries.some((query) => query.includes('"Software Development Engineer"'))).toBe(true);
  });
  it('discovers Greenhouse, Lever and Ashby boards from individual public job URLs', () => {
    expect(crawler.atsBoardFromUrl('https://boards.greenhouse.io/acme/jobs/123')).toEqual({ provider: 'greenhouse', board: 'acme' });
    expect(crawler.atsBoardFromUrl('https://jobs.lever.co/acme/abc-123')).toEqual({ provider: 'lever', board: 'acme' });
    expect(crawler.atsBoardFromUrl('https://jobs.ashbyhq.com/acme/abc-123')).toEqual({ provider: 'ashby', board: 'acme' });
    expect(crawler.atsBoardFromUrl('https://example.com/careers/java-developer')).toBeUndefined();
  });
  it('maps ATS board API records to traceable job records with direct application links', () => {
    const greenhouse = crawler.mapAtsJob({ provider: 'greenhouse', board: 'acme' }, {
      id: 123,
      title: 'Java Developer',
      company_name: 'Acme',
      location: { name: 'Bengaluru, India' },
      content: '<p>Build Java services</p>',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/123'
    });
    expect(greenhouse).toMatchObject({
      title: 'Java Developer',
      company: 'Acme',
      location: 'Bengaluru, India',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      applicationUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      source: 'serper-search'
    });
    expect((greenhouse?.raw as Record<string, unknown>).atsProvider).toBe('greenhouse');
    const lever = crawler.mapAtsJob({ provider: 'lever', board: 'acme' }, {
      id: 'lever-id', text: 'Java Developer', categories: { location: 'Bengaluru, India' },
      hostedUrl: 'https://jobs.lever.co/acme/lever-id', applyUrl: 'https://jobs.lever.co/acme/lever-id/apply',
      descriptionPlain: 'Build Java applications'
    });
    expect(lever).toMatchObject({
      title: 'Java Developer', location: 'Bengaluru, India',
      applicationUrl: 'https://jobs.lever.co/acme/lever-id/apply'
    });
    const ashby = crawler.mapAtsJob({ provider: 'ashby', board: 'acme' }, {
      id: 'ashby-id', title: 'Java Developer', location: 'Bengaluru, India',
      jobUrl: 'https://jobs.ashbyhq.com/acme/ashby-id', applyUrl: 'https://jobs.ashbyhq.com/acme/ashby-id/application',
      descriptionPlain: 'Build Java applications', isListed: true
    });
    expect(ashby).toMatchObject({
      title: 'Java Developer', location: 'Bengaluru, India',
      applicationUrl: 'https://jobs.ashbyhq.com/acme/ashby-id/application'
    });
  });
  it('discovers embedded ATS careers boards from iframe sources', () => {
    const page = crawler.parsePage('<html><body><iframe src="https://jobs.ashbyhq.com/acme"></iframe></body></html>', 'https://acme.example/careers');
    expect(page.links).toContainEqual({ url: 'https://jobs.ashbyhq.com/acme', text: 'Embedded career listings' });
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
    expect(crawler.isJobUrl('https://recruitment.example.gov.in/notices/2026/45', 'Java Developer recruitment notification')).toBe(true);
    expect(crawler.isJobUrl('https://university.example.edu/careers/opening-123')).toBe(true);
    expect(crawler.isJobUrl('https://procurement.example.gov.in/notices/it-services-12', 'Tender for Java application development services')).toBe(true);
    expect(crawler.isJobUrl('https://www.naukri.com/job-listings-java-developer-123')).toBe(true);
    expect(crawler.isJobUrl('https://www.indeed.com/viewjob?jk=abc123')).toBe(true);
    expect(crawler.isJobUrl('https://example.com/about')).toBe(false);
    expect(crawler.safeUrl('http://127.0.0.1/admin')).toBeUndefined();
    expect(crawler.safeUrl('file:///etc/passwd')).toBeUndefined();
  });
  it('normalizes Serper organic results into the crawler input shape', () => {
    const normalized = crawler.normalizeSearchResponse({ organic: [{ title: 'Java Developer - Acme', link: 'https://jobs.lever.co/acme/123', snippet: 'Java roles in Bengaluru', domain: 'jobs.lever.co', date: '2 days ago' }] });
    expect(normalized.results).toHaveLength(1);
    expect(normalized.results[0].url).toBe('https://jobs.lever.co/acme/123');
    expect(normalized.results[0].description).toBe('Java roles in Bengaluru');
    expect(normalized.results[0].profile).toEqual({ name: '', long_name: 'jobs.lever.co' });
  });
  it('extracts schema.org JobPosting structured data', () => {
    const html = '<html><head><title>Java Developer - Acme</title><meta name="description" content="Java role in Bengaluru"></head><body><a href="/jobs/java-developer">Java Developer opening</a><script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Java Developer","hiringOrganization":{"@type":"Organization","name":"Acme"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Bengaluru","addressCountry":"India"}},"description":"Build Java services"}</script></body></html>';
    const page = crawler.parsePage(html, 'https://jobs.lever.co/acme/123');
    expect(page.title).toBe('Java Developer - Acme');
    expect(page.postings).toHaveLength(1);
    expect(page.postings[0].title).toBe('Java Developer');
    expect(page.links).toContainEqual({ url: 'https://jobs.lever.co/jobs/java-developer', text: 'Java Developer opening' });
  });
});
