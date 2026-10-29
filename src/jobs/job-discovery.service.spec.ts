import { resolveJobicyGeo } from './job-discovery.service';

describe('resolveJobicyGeo', () => {
  it('maps Indian city preferences to APAC remote eligibility', () => {
    expect(resolveJobicyGeo({ jobTitle: 'Software Developer', location: 'Bengaluru' })).toBe('apac');
    expect(resolveJobicyGeo({ jobTitle: 'Backend Engineer', location: 'Delhi NCR' })).toBe('apac');
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
