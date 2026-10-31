import type { JobProfile, NormalizedJob } from './job.types';

export interface TemplateContext {
  profile: JobProfile;
  limit?: number;
  job?: NormalizedJob;
}

export function resolveTemplate(template: Record<string, unknown>, context: TemplateContext): Record<string, unknown> {
  const output = resolveValue(template, context);
  return output && typeof output === 'object' && !Array.isArray(output) ? output as Record<string, unknown> : {};
}

function resolveValue(value: unknown, context: TemplateContext): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$profile === 'string') return context.profile[object.$profile as keyof JobProfile];
    if (Object.keys(object).length === 1 && typeof object.$job === 'string') return context.job?.[object.$job as keyof NormalizedJob];
    if (Object.keys(object).length === 1 && object.$context === 'limit') return context.limit;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      const resolved = resolveValue(child, context);
      if (resolved !== undefined) result[key] = resolved;
    }
    return result;
  }
  if (typeof value === 'string') {
    const match = /^\{\{(profile|job)\.([a-zA-Z0-9_]+)(?:\|(csv|join))?\}\}$/.exec(value);
    if (match) {
      const result = match[1] === 'profile' ? context.profile[match[2] as keyof JobProfile] : context.job?.[match[2] as keyof NormalizedJob];
      return match[3] && Array.isArray(result) ? result.join(', ') : result;
    }
    if (value === '{{limit}}') return context.limit;
    return value.replace(/\{\{(profile|job)\.([a-zA-Z0-9_]+)(?:\|(csv|join))?\}\}/g, (_whole, kind: string, key: string) => {
      const result = kind === 'profile' ? context.profile[key as keyof JobProfile] : context.job?.[key as keyof NormalizedJob];
      if (Array.isArray(result)) return result.join(', ');
      if (result === undefined || result === null) return '';
      return String(result);
    });
  }
  return value;
}
