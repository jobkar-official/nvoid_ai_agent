const apifyBoards = require('../../scripts/apify-job-boards-mcp-server.cjs') as {
  matchesRole: (job: Record<string, unknown>, query: string) => boolean;
  matchesLocation: (job: Record<string, unknown>, requested: string, remoteOnly: boolean) => boolean;
  roleFamily: (value: string) => string | undefined;
  mapItem: (item: Record<string, unknown>) => Record<string, unknown>;
  displayLocation: (item: Record<string, unknown>) => string;
};

describe('Apify multi-board job source', () => {
  it('matches the requested job family and specific skills', () => {
    expect(apifyBoards.matchesRole({
      title: 'Senior Java Backend Developer',
      skills: ['Java', 'Spring Boot'],
    }, 'Java Backend Developer')).toBe(true);

    expect(apifyBoards.matchesRole({
      title: 'DevOps Engineer',
      skills: ['Kubernetes', 'AWS'],
    }, 'Java Backend Developer')).toBe(false);
  });

  it('rejects jobs with unknown location eligibility for a specific city', () => {
    expect(apifyBoards.matchesLocation({
      title: 'Backend Developer',
      location: 'Bengaluru, India',
    }, 'Bengaluru', false)).toBe(true);

    expect(apifyBoards.matchesLocation({
      title: 'Backend Developer',
      location: 'Australia',
    }, 'Bengaluru', false)).toBe(false);

    expect(apifyBoards.matchesLocation({
      title: 'Backend Developer',
      location: 'United States',
    }, 'Bengaluru', false)).toBe(false);

    expect(apifyBoards.matchesLocation({
      title: 'Backend Developer',
      location: '',
      description: 'Remote role for a distributed team.',
    }, 'Bengaluru', true)).toBe(false);
  });

  it('maps multi-board results into source-attributed records with original and direct URLs', () => {
    const job = apifyBoards.mapItem({
      id: 'job-123',
      site: 'indeed',
      title: 'Software Engineer',
      company: 'Example Co',
      location: 'Bengaluru, India',
      job_url: 'https://in.indeed.com/viewjob?jk=job-123',
      job_url_direct: 'https://careers.example.com/jobs/123',
      date_posted: '2026-10-29',
      salary_min: 100000,
      salary_max: 150000,
      salary_currency: 'INR',
    });

    expect(job.source).toBe('indeed');
    expect(job.title).toBe('Software Engineer');
    expect(job.jobUrl).toBe('https://in.indeed.com/viewjob?jk=job-123');
    expect(job.directUrl).toBe('https://careers.example.com/jobs/123');
    expect(job.postedAt).toBe('2026-10-29');
    expect(job.salaryMin).toBe(100000);
    expect(job.salaryMax).toBe(150000);
  });

  it('shows the job eligibility provided by the board actor', () => {
    expect(apifyBoards.displayLocation({
      location: 'Remote',
      locationRestrictions: ['India', 'APAC']
    })).toBe('Remote · India APAC');
    expect(apifyBoards.displayLocation({
      description: 'Remote job available worldwide.'
    })).toBe('Worldwide');
  });

  it('preserves Apna as a distinct provider rather than labeling it as an aggregator', () => {
    const job = apifyBoards.mapItem({
      jobId: 'apna-123',
      title: 'Sales Executive',
      employer: 'Example Retail',
      location: 'Delhi NCR, India',
      canonicalUrl: 'https://apna.co/job/delhi/sales-executive-123',
      source: 'apna.co',
    });
    expect(job.source).toBe('apna');
    expect(job.jobUrl).toBe('https://apna.co/job/delhi/sales-executive-123');
  });
});
