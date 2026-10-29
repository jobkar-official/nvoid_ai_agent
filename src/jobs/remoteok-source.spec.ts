const remoteOkFilters = require('../../scripts/remoteok-mcp-server.cjs') as {
  matchesLocation: (job: Record<string, unknown>, requested: string) => boolean;
  matchesQuery: (job: Record<string, unknown>, query: string) => boolean;
  regionFor: (value: string) => string | undefined;
};

describe('Remote OK live source filters', () => {
  it('matches the requested job title and relevant terms from tags or descriptions', () => {
    expect(remoteOkFilters.matchesQuery({
      position: 'Senior Software Engineer',
      tags: ['typescript', 'backend'],
      description: 'Build cloud APIs using TypeScript.'
    }, 'Software Developer backend TypeScript')).toBe(true);

    expect(remoteOkFilters.matchesQuery({
      position: 'Sales Operations Lead',
      tags: ['sales', 'operations'],
      description: 'Manage a sales pipeline.'
    }, 'Java Backend Engineer')).toBe(false);
  });

  it('matches explicit regional eligibility and excludes conflicting regions', () => {
    expect(remoteOkFilters.matchesLocation({
      location: 'APAC',
      position: 'Software Engineer'
    }, 'Bengaluru')).toBe(true);

    expect(remoteOkFilters.matchesLocation({
      location: '',
      position: 'Senior Software Engineer',
      description: 'Remote role based in Latin America.'
    }, 'Bengaluru')).toBe(false);
  });

  it('accepts explicit worldwide listings but rejects unknown eligibility for a specific location', () => {
    expect(remoteOkFilters.matchesLocation({
      location: 'Worldwide',
      position: 'Backend Developer'
    }, 'Bengaluru')).toBe(true);

    expect(remoteOkFilters.matchesLocation({
      location: '',
      position: 'Backend Developer',
      description: 'Work remotely with a distributed team.'
    }, 'Bengaluru')).toBe(false);
  });

  it('maps known regions consistently', () => {
    expect(remoteOkFilters.regionFor('Bengaluru, India')).toBe('apac');
    expect(remoteOkFilters.regionFor('Remote role based in Latin America')).toBe('latin-america');
    expect(remoteOkFilters.regionFor('Berlin, Germany')).toBe('europe');
  });
});
