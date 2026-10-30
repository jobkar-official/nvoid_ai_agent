import { buildJobDetailArguments, extractSearchId, isJobDetailTool, parseJobDataLakeDetailResult, parseJobDataLakeSearchResult } from './job-discovery.service';
import type { JobProfile, NormalizedJob } from '../common/job.types';

const profile: JobProfile = {
  jobTitle: 'Business Development Manager',
  location: 'Noida',
  countries: ['India'],
};

const job: NormalizedJob = {
  id: 'normalized-1',
  source: 'linkedin',
  sourceJobId: '4481120122',
  title: 'Business Development Manager',
  company: 'Example Corp',
  location: 'Noida, India',
  jobUrl: 'https://www.linkedin.com/jobs/view/4481120122',
  applicationUrl: 'https://careers.example.com/jobs/4481120122',
  matchScore: 92,
  matchReasons: [],
  raw: { id: '4481120122', search_id: 'search-123' },
};

describe('job detail MCP lookup helpers', () => {

  it('parses JobDataLake text search cards into normalized listing records', () => {
    const jobs = parseJobDataLakeSearchResult({
      content: [{
        type: 'text',
        text: [
          '📊 498/500 free calls remaining today',
          '',
          'Found 1,234 jobs (showing 1):',
          '',
          '1. **Senior Business Development Manager** at Example Corp',
          '   Noida, India | hybrid | $120k - $150k',
          '   Skills: Enterprise Sales, Partnerships, CRM',
          '   Apply: https://careers.example.com/jobs/123',
          '   ID: example-senior-bdm-a1b2',
        ].join('\n'),
      }],
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'example-senior-bdm-a1b2',
      job_handle: 'example-senior-bdm-a1b2',
      title: 'Senior Business Development Manager',
      company: 'Example Corp',
      location: 'Noida, India',
      workMode: 'hybrid',
      salary: '$120k - $150k',
      url: 'https://careers.example.com/jobs/123',
    });
  });

  it('parses the full JobDataLake job detail response', () => {
    const details = parseJobDataLakeDetailResult({
      content: [{
        type: 'text',
        text: [
          '**Senior Business Development Manager** at Example Corp',
          '',
          'Location: Noida, India',
          'Salary: $120k - $150k',
          'Seniority: Senior, Manager',
          'Skills: Enterprise Sales, Partnerships, CRM',
          'Type: Full-time',
          'Apply: https://careers.example.com/jobs/123',
          '',
          '---',
          '',
          'Own strategic partnerships and enterprise customer growth.',
        ].join('\n'),
      }],
    });

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      title: 'Senior Business Development Manager',
      company: 'Example Corp',
      location: 'Noida, India',
      salary: '$120k - $150k',
      seniority: 'Senior, Manager',
      employment_type: 'Full-time',
      applicationUrl: 'https://careers.example.com/jobs/123',
      description: 'Own strategic partnerships and enterprise customer growth.',
    });
  });

  it('extracts a JobSpy search id from structured MCP content', () => {
    expect(extractSearchId({
      structuredContent: {
        search_id: 'search-123',
        jobs: [{ id: 'job-1', title: 'Business Development Manager' }],
      },
    })).toBe('search-123');
  });

  it('extracts a search id from the text-only MCP response fallback', () => {
    expect(extractSearchId({
      content: [{ type: 'text', text: JSON.stringify({ search_id: 'search-456', jobs: [] }) }],
    })).toBe('search-456');
  });

  it('recognizes provider-specific read-only detail tool names', () => {
    expect(isJobDetailTool('get_job_details')).toBe(true);
    expect(isJobDetailTool('linkedin_get_job_detail')).toBe(true);
    expect(isJobDetailTool('get_job')).toBe(true);
    expect(isJobDetailTool('apply_to_job')).toBe(false);
  });

  it('maps JobSpy search identifiers to its batch detail tool schema', () => {
    expect(buildJobDetailArguments({
      type: 'object',
      properties: {
        search_id: { type: 'string' },
        job_ids: { type: 'array' },
      },
      required: ['search_id', 'job_ids'],
    }, job, profile)).toEqual({
      search_id: 'search-123',
      job_ids: ['4481120122'],
    });
  });

  it('maps a LinkedIn detail lookup to the source job id', () => {
    expect(buildJobDetailArguments({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    }, job, profile)).toEqual({ id: '4481120122' });
  });

  it('maps an ATS detail lookup to its original posting URL', () => {
    expect(buildJobDetailArguments({
      type: 'object',
      properties: { job_url: { type: 'string' } },
      required: ['job_url'],
    }, job, profile)).toEqual({ job_url: 'https://www.linkedin.com/jobs/view/4481120122' });
  });

  it('does not call a detail tool when required identifiers are unavailable', () => {
    const withoutSearchId = { ...job, raw: { id: '4481120122' } };
    expect(buildJobDetailArguments({
      type: 'object',
      properties: {
        search_id: { type: 'string' },
        job_ids: { type: 'array' },
      },
      required: ['search_id', 'job_ids'],
    }, withoutSearchId, profile)).toBeUndefined();
  });
});
