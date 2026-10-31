const filters = require('../../scripts/public-job-boards-mcp-server.cjs') as {
  matchesRole: (job: Record<string, unknown>, query: string) => boolean;
  matchesLocation: (job: Record<string, unknown>, requested: string, remoteOnly?: boolean) => boolean;
  roleFamily: (value: string) => string | undefined;
  regionFor: (value: string) => string | undefined;
  displayLocation: (job: Record<string, unknown>, remoteFallback?: boolean) => string;
};

describe('public job board source matching', () => {
  it('matches related software titles while excluding unrelated job families', () => {
    expect(filters.matchesRole({ title: 'Senior Software Engineer' }, 'Software Developer')).toBe(true);
    expect(filters.matchesRole({ title: 'Backend Developer', tags: ['API'] }, 'Software Developer')).toBe(true);
    expect(filters.matchesRole({ title: 'DevOps Engineer', tags: ['Kubernetes'] }, 'Software Developer')).toBe(false);
    expect(filters.matchesRole({ title: 'Technical Support Engineer' }, 'Software Developer')).toBe(false);
    expect(filters.matchesRole({ title: 'Sales Operations Lead' }, 'Software Developer')).toBe(false);
  });

  it('requires specific technology evidence for a specific role', () => {
    expect(filters.matchesRole({ title: 'Senior Java Developer' }, 'Java Developer')).toBe(true);
    expect(filters.matchesRole({ title: 'Senior Python Engineer' }, 'Java Developer')).toBe(false);
    expect(filters.matchesRole({ title: 'Backend Engineer', tags: ['Java', 'Spring Boot'] }, 'Java Developer')).toBe(true);
  });

  it('matches exact locations, countries and supported regions', () => {
    expect(filters.matchesLocation({ location: 'Bengaluru, India' }, 'Bengaluru, India', true)).toBe(true);
    expect(filters.matchesLocation({ location: 'India' }, 'Bengaluru', true)).toBe(true);
    expect(filters.matchesLocation({ location: 'APAC' }, 'Bengaluru', true)).toBe(true);
    expect(filters.matchesLocation({ location: 'Australia' }, 'Bengaluru', true)).toBe(false);
    expect(filters.matchesLocation({ location: 'United States' }, 'Bengaluru', true)).toBe(false);
  });

  it('retains remote listings when country eligibility is not supplied', () => {
    expect(filters.matchesLocation({ location: 'Remote · eligibility not stated' }, 'Bengaluru', true)).toBe(true);
    expect(filters.matchesLocation({ description: 'Work remotely with a distributed team.' }, 'Bengaluru', true)).toBe(true);
    expect(filters.matchesLocation({ location: 'Worldwide remote' }, 'Bengaluru', true)).toBe(true);
  });

  it('recognizes explicit country eligibility in job descriptions', () => {
    expect(filters.matchesLocation({
      description: 'Remote role. Candidates must be located in India.'
    }, 'Bengaluru', true)).toBe(true);
    expect(filters.matchesLocation({
      description: 'Remote role. Candidates must be located in the United States.'
    }, 'Bengaluru', true)).toBe(false);
  });

  it('labels global and country-restricted remote listings with the provided eligibility', () => {
    expect(filters.displayLocation({
      location: 'Remote',
      location_restrictions: ['India', 'Singapore']
    }, true)).toBe('Remote · India Singapore');
    expect(filters.displayLocation({
      description: 'The role is available worldwide.'
    }, true)).toBe('Worldwide');
  });

  it('recognizes provider geographic regions', () => {
    expect(filters.regionFor('Bengaluru, India')).toBe('apac');
    expect(filters.regionFor('Berlin, Germany')).toBe('europe');
    expect(filters.roleFamily('Software Developer')).toBe('software-engineering');
    expect(filters.roleFamily('Data Engineer')).toBe('data-engineering');
  });
});
