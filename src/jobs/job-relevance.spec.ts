import type { NormalizedJob, JobProfile } from '../common/job.types';
import { matchesJobLocation, matchesJobTitle } from './job-relevance';

const profile: JobProfile = {
  jobTitle: 'Software Developer',
  location: 'Bengaluru',
  countries: ['India'],
  skills: ['TypeScript'],
  remote: true,
};

function job(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: 'test-job',
    source: 'test',
    title: 'Senior Software Engineer',
    location: 'Worldwide',
    jobUrl: 'https://jobs.example.test/1',
    matchScore: 80,
    matchReasons: [],
    raw: {},
    ...overrides,
  };
}

describe('job relevance filters', () => {
  it('matches related software engineering titles but not unrelated engineering jobs', () => {
    expect(matchesJobTitle('Senior Software Engineer', {}, 'Software Developer')).toBe(true);
    expect(matchesJobTitle('Backend Developer', {}, 'Software Developer')).toBe(true);
    expect(matchesJobTitle('DevOps Engineer', {}, 'Software Developer')).toBe(false);
    expect(matchesJobTitle('Technical Support Engineer', {}, 'Software Developer')).toBe(false);
    expect(matchesJobTitle('Sales Operations Lead', {}, 'Software Developer')).toBe(false);
    expect(matchesJobTitle('Software Engineering Director', {}, 'Software Developer', 3)).toBe(false);
    expect(matchesJobTitle('Lead Software Engineer', {}, 'Software Developer', 3)).toBe(false);
    expect(matchesJobTitle('Software Engineer Intern', {}, 'Software Developer', 3)).toBe(false);
    expect(matchesJobTitle('Engineering Director', {}, 'Engineering Director', 12)).toBe(true);
  });

  it('uses the target technology when the target role is specific', () => {
    expect(matchesJobTitle('Senior Java Developer', {}, 'Java Developer')).toBe(true);
    expect(matchesJobTitle('Senior Python Engineer', {}, 'Java Developer')).toBe(false);
    expect(matchesJobTitle('Backend Engineer', { tags: ['Java', 'Spring Boot'] }, 'Java Developer')).toBe(true);
  });

  it('matches a specified city through exact location, country or an eligible region', () => {
    expect(matchesJobLocation(job({ location: 'Bengaluru, India' }), profile)).toBe(true);
    expect(matchesJobLocation(job({ location: 'India', raw: { indexedSnippet: 'The engineering position is based in Bangalore.' } }), profile)).toBe(true);
    expect(matchesJobLocation(job({ location: 'India', workMode: 'Remote' }), profile)).toBe(true);
    expect(matchesJobLocation(job({ location: 'India', workMode: 'On-site' }), profile)).toBe(false);
    expect(matchesJobLocation(job({ location: 'APAC remote', workMode: 'Remote' }), profile)).toBe(true);
    expect(matchesJobLocation(job({ location: 'Worldwide' }), profile)).toBe(true);
  });

  it('rejects conflicting country restrictions but keeps remote jobs with unspecified eligibility', () => {
    expect(matchesJobLocation(job({ location: 'United States' }), profile)).toBe(false);
    expect(matchesJobLocation(job({ location: 'Remote · eligibility not stated', workMode: 'Remote' }), profile)).toBe(true);
    expect(matchesJobLocation(job({
      location: undefined,
      workMode: 'Remote',
      raw: { description: 'Work remotely with a distributed team.' },
    }), profile)).toBe(true);
  });

  it('accepts only explicit target region restrictions when the job omits its location field', () => {
    expect(matchesJobLocation(job({
      location: undefined,
      workMode: 'Remote',
      raw: { description: 'Remote role. Candidates must be located in India.' },
    }), profile)).toBe(true);
    expect(matchesJobLocation(job({
      location: undefined,
      workMode: 'Remote',
      raw: { description: 'Remote role. Candidates must be located in the United States.' },
    }), profile)).toBe(false);
  });

  it('uses country preferences when the location field is empty, but rejects an empty profile', () => {
    expect(matchesJobLocation(job({ location: 'India' }), { jobTitle: 'Software Developer', countries: ['India'] })).toBe(true);
    expect(matchesJobLocation(job({ location: 'India' }), { jobTitle: 'Software Developer' })).toBe(false);
  });
});
