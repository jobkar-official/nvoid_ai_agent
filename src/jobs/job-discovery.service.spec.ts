import { inferArguments, resolveJobicyGeo } from './job-discovery.service';

describe('resolveJobicyGeo', () => {
  it('maps Indian city preferences to APAC remote eligibility', () => {
    expect(resolveJobicyGeo({ jobTitle: 'Software Developer', location: 'Bengaluru' })).toBe('apac');
    expect(resolveJobicyGeo({ jobTitle: 'Backend Engineer', location: 'Delhi NCR' })).toBe('apac');
  });

  it('uses Jobicy country slugs for supported country-specific filters', () => {
    expect(resolveJobicyGeo({ jobTitle: 'Developer', location: 'Toronto, Canada' })).toBe('canada');
  });

  it('maps known European and US preferences to their supported regions', () => {
    expect(resolveJobicyGeo({ jobTitle: 'Developer', location: 'London, UK' })).toBe('europe');
    expect(resolveJobicyGeo({ jobTitle: 'Developer', location: 'New York, USA' })).toBe('usa');
  });

  it('keeps broad or ambiguous geographic preferences unfiltered', () => {
    expect(resolveJobicyGeo({ jobTitle: 'Developer', location: 'Worldwide' })).toBe('anywhere');
    expect(resolveJobicyGeo({ jobTitle: 'Developer', countries: ['India', 'Germany', 'Canada'] })).toBe('anywhere');
  });

  it('uses a single inferred country region when no specific location is entered', () => {
    expect(resolveJobicyGeo({ jobTitle: 'Developer', countries: ['India'] })).toBe('apac');
  });
});


describe('inferArguments', () => {
  it('maps profile countries to ISO alpha-3 when the MCP schema requires it', () => {
    expect(inferArguments({
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        country: { type: 'string', description: 'ISO 3166-1 alpha-3 country code', pattern: '^[A-Z]{3}$' },
      },
      required: ['keyword', 'country'],
    }, {
      jobTitle: 'Backend Engineer',
      location: 'Bengaluru, India',
    }, 20)).toEqual({ keyword: 'Backend Engineer', country: 'IND' });
  });

  it('maps employment filters to the exact provider enum values', () => {
    expect(inferArguments({
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        job_type: { type: 'string', description: 'Employment type', enum: ['full_time', 'part_time', 'internship'] },
        employment_type: { type: 'string', description: 'Employment type', enum: ['FULL_TIME', 'PART_TIME', 'TEMPORARY', 'INTERN'] },
      },
      required: ['keyword'],
    }, {
      jobTitle: 'Software Developer',
      location: 'Bengaluru, India',
      employmentTypes: ['full-time'],
    }, 20)).toEqual({
      keyword: 'Software Developer',
      job_type: 'full_time',
      employment_type: 'FULL_TIME',
    });
  });

  it('maps India to a broad Asia area only when that exact option exists in the provider schema', () => {
    expect(inferArguments({
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        area: { type: 'string', enum: ['Taipei', 'OtherAsia', 'AustraliaNZ'] },
      },
      required: ['keyword', 'area'],
    }, {
      jobTitle: 'Software Developer',
      location: 'Bengaluru, India',
    }, 20)).toEqual({ keyword: 'Software Developer', area: 'OtherAsia' });
  });

  it('skips required locations when the provider schema has no value for the requested location', () => {
    expect(inferArguments({
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        location: { type: 'string', enum: ['Taiwan', 'Canada', 'Japan-Yokohama'] },
      },
      required: ['keyword', 'location'],
    }, {
      jobTitle: 'Software Developer',
      location: 'Bengaluru, India',
    }, 20)).toBeUndefined();
  });

  it('does not send a full-time employment filter to a provider that only exposes job-level values', () => {
    expect(inferArguments({
      type: 'object',
      properties: {
        keyword: { type: 'string' },
        job_type: { type: 'string', description: 'Job level filter', enum: ['Technician', 'Engineer / Admin', 'Manager / Executive'] },
      },
      required: ['keyword'],
    }, {
      jobTitle: 'Software Developer',
      location: 'Worldwide',
      employmentTypes: ['full-time'],
    }, 20)).toEqual({ keyword: 'Software Developer' });
  });

  it('maps ISO alpha-2 countries from the profile when the schema requires it', () => {
    expect(inferArguments({
      type: 'object',
      properties: {
        countries: { type: 'string', description: 'Comma-separated lowercase ISO 3166-1 alpha-2 codes' },
      },
    }, {
      jobTitle: 'Software Developer',
      location: 'Worldwide',
      countries: ['India', 'Canada'],
    }, 20)).toEqual({ countries: 'in,ca' });
  });
});
