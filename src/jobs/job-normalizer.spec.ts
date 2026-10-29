import { calculateMatchScore, normalizeJob, parseMcpJobResult } from './job-normalizer';
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

  it('rejects records without a job title', () => {
    expect(normalizeJob({ company: 'Example' }, 'example-mcp', profile)).toBeUndefined();
  });

  it('caps deterministic match scores at 100', () => {
    const result = calculateMatchScore({
      description: 'TypeScript Node.js PostgreSQL backend remote',
      salaryMin: 120000,
      salaryMax: 180000,
      workMode: 'remote',
    }, 'Senior Backend Engineer', 'Bengaluru', profile);

    expect(result.score).toBe(100);
  });
});
