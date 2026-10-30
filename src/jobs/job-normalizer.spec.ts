import { calculateMatchScore, normalizeJob, parseMcpJobResult, resolveRemoteOkApplicationUrl } from './job-normalizer';
import type { JobProfile } from '../common/job.types';

const profile: JobProfile = {
  userId: 'candidate-1',
  jobTitle: 'Senior Backend Engineer',
  location: 'Bengaluru',
  skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
  keywords: ['backend'],
  remote: true,
  salaryMin: 100000,
  salaryMax: 200000,
};

describe('job-normalizer', () => {
  it('parses jobs nested in MCP structured content', () => {
    expect(parseMcpJobResult({
      structuredContent: {
        data: {
          jobs: [{ title: 'Backend Engineer', company: 'Example', url: 'https://jobs.example.com/role/1' }],
        },
      },
    })).toEqual([{ title: 'Backend Engineer', company: 'Example', url: 'https://jobs.example.com/role/1' }]);
  });

  it('normalizes job links and removes tracking parameters', () => {
    const job = normalizeJob({
      id: 'role-1',
      title: 'Senior Backend Engineer',
      company: 'Example',
      location: 'Bengaluru',
      url: 'https://jobs.example.com/role/1?utm_source=feed&ref=tracker#details',
    }, 'example-mcp', profile);

    expect(job).toBeDefined();
    expect(job?.jobUrl).toBe('https://jobs.example.com/role/1');
    expect(job?.applicationUrl).toBe('https://jobs.example.com/role/1');
    expect(job?.sourceJobId).toBe('role-1');
    expect(job?.matchScore).toBeGreaterThanOrEqual(0);
    expect(job?.matchScore).toBeLessThanOrEqual(100);
  });

  it('normalizes abbreviated LinkedIn MCP Zero records without losing source fields', () => {
    const job = normalizeJob({
      id: '4481120122',
      t: 'Senior Product Engineer',
      co: 'Example Labs',
      loc: 'Noida, India',
      sal: '₹18L-24L per year',
      posted: '2026-10-29',
      url: 'https://www.linkedin.com/jobs/view/4481120122',
      remote: true,
    }, 'linkedin', profile);

    expect(job?.title).toBe('Senior Product Engineer');
    expect(job?.company).toBe('Example Labs');
    expect(job?.location).toBe('Noida, India');
    expect(job?.salary).toBe('₹18L-24L per year');
    expect(job?.postedAt).toBe('2026-10-29');
    expect(job?.workMode).toBe('Remote');
    expect(job?.jobUrl).toBe('https://www.linkedin.com/jobs/view/4481120122');
  });

  it('normalizes live Jobicy listing metadata without fabricating missing fields', () => {
    const job = normalizeJob({
      id: 90210,
      jobTitle: 'Senior Software Engineer',
      companyName: 'Live Example Corp',
      jobGeo: 'Asia / Remote',
      jobType: ['Full-time'],
      jobLevel: 'Senior',
      jobDescription: 'A live remote engineering role.',
      url: 'https://jobicy.com/jobs/90210-senior-software-engineer',
      pubDate: '2026-10-29T10:00:00Z'
    }, 'jobicy', profile);

    expect(job?.title).toBe('Senior Software Engineer');
    expect(job?.company).toBe('Live Example Corp');
    expect(job?.location).toBe('Asia / Remote');
    expect(job?.workMode).toBe('Remote');
    expect(job?.postedAt).toBe('2026-10-29T10:00:00Z');
    expect(job?.jobUrl).toBe('https://jobicy.com/jobs/90210-senior-software-engineer');
  });

  it('normalizes Remote OK listing and explicit direct-apply URLs', () => {
    const job = normalizeJob({
      id: 'remoteok-1',
      position: 'TypeScript Engineer',
      company: 'Live Example',
      location: 'Worldwide',
      description: 'Build APIs in TypeScript.',
      tags: ['typescript', 'backend'],
      date: '2026-10-29T10:00:00Z',
      url: 'https://remoteok.com/remote-jobs/remoteok-1',
      apply_url: 'https://careers.example.org/jobs/remoteok-1'
    }, 'remoteok', profile);

    expect(job?.title).toBe('TypeScript Engineer');
    expect(job?.jobUrl).toBe('https://remoteok.com/remote-jobs/remoteok-1');
    expect(job?.applicationUrl).toBe('https://careers.example.org/jobs/remoteok-1');
    expect(job?.postedAt).toBe('2026-10-29T10:00:00Z');
  });

  it('does not treat the Remote OK listing URL as a direct employer application URL', () => {
    expect(resolveRemoteOkApplicationUrl(
      'https://remoteok.com/remote-jobs/remote-software-engineer-123',
      'https://remoteOK.com/remote-jobs/remote-software-engineer-123'
    )).toBeUndefined();
    expect(resolveRemoteOkApplicationUrl(
      'https://remoteok.com/remote-jobs/remote-software-engineer-123',
      'https://www.remoteok.com/remote-jobs/remote-software-engineer-123'
    )).toBeUndefined();
  });

  it('accepts a distinct external employer application URL from Remote OK', () => {
    expect(resolveRemoteOkApplicationUrl(
      'https://remoteok.com/remote-jobs/remote-software-engineer-123',
      'https://careers.example.org/jobs/123'
    )).toBe('https://careers.example.org/jobs/123');
  });

  it('rejects records without a job title', () => {
    expect(normalizeJob({ company: 'Example' }, 'example-mcp', profile)).toBeUndefined();
  });

  it('caps deterministic match scores at 100', () => {
    const result = calculateMatchScore({
      description: 'TypeScript Node.js PostgreSQL backend remote',
      salaryMin: 120000,
      salaryMax: 180000,
      workMode: 'remote',
    }, 'Senior Backend Engineer', 'Bengaluru', { ...profile, skills: Array.from({ length: 20 }, () => 'backend') });

    expect(result.score).toBe(100);
  });
});
