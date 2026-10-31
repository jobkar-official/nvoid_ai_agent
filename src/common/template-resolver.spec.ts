import { resolveTemplate } from './template-resolver';
import type { JobProfile } from './job.types';

describe('resolveTemplate', () => {
  const profile = {
    jobTitle: 'Backend Engineer',
    location: 'Bengaluru',
    skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
  } as JobProfile;

  it('preserves array values for array-typed MCP inputs', () => {
    expect(resolveTemplate({ skills: { '$profile': 'skills' } }, { profile })).toEqual({
      skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
    });
  });

  it('supports CSV serialization for string-typed MCP inputs', () => {
    expect(resolveTemplate({ skills: '{{profile.skills|csv}}' }, { profile })).toEqual({
      skills: 'TypeScript, Node.js, PostgreSQL',
    });
  });
});
