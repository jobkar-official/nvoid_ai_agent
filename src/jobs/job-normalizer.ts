import { createHash } from 'node:crypto';
import type { JobProfile, NormalizedJob } from '../common/job.types';

const TITLE_KEYS = ['title', 'jobTitle', 'job_title', 'position', 'role', 'name', 'designation', 't'];
const COMPANY_KEYS = ['company', 'companyName', 'company_name', 'employer', 'organization', 'organisation', 'co'];
const URL_KEYS = ['applicationUrl', 'application_url', 'applyUrl', 'apply_url', 'applyLink', 'apply_link', 'careerUrl', 'career_url', 'jobUrl', 'job_url', 'job_url_direct', 'url', 'link', 'externalUrl'];
const ID_KEYS = ['id', 'jobId', 'job_id', 'jobKey', 'job_key', 'key', 'slug', 'externalId', 'external_id', 'job_uuid'];
const LOCATION_KEYS = ['location', 'jobLocation', 'job_location', 'jobGeo', 'job_geo', 'locationRestrictions', 'location_restrictions', 'allowedCountries', 'allowed_countries', 'eligibleLocations', 'eligible_locations', 'city', 'locations', 'address', 'region', 'loc'];
const DESCRIPTION_KEYS = ['description', 'jobDescription', 'job_description', 'excerpt', 'jobExcerpt', 'job_excerpt', 'shortDescription', 'short_description', 'summary', 'details', 'snippet'];
const SALARY_MIN_KEYS = ['salaryMin', 'salary_min', 'minSalary', 'min_salary', 'salary_from', 'minimumSalary', 'min_amount'];
const SALARY_MAX_KEYS = ['salaryMax', 'salary_max', 'maxSalary', 'max_salary', 'salary_to', 'maximumSalary', 'max_amount'];
const POSTED_KEYS = ['postedAt', 'posted_at', 'posted', 'postedDate', 'posted_date', 'datePosted', 'date_posted', 'createdAt', 'created_at', 'publishedAt', 'published_at', 'pubDate', 'pub_date', 'date', 'epoch', 'age'];

export function parseMcpJobResult(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const root = result as Record<string, unknown>;
  const records: unknown[] = [];
  if ('structuredContent' in root) collectCandidates(root.structuredContent, records, 0);
  if ('content' in root) collectCandidates(root.content, records, 0);
  if (records.length === 0) collectCandidates(root, records, 0);
  return records;
}

function collectCandidates(value: unknown, records: unknown[], depth: number): void {
  if (depth > 9 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { collectCandidates(JSON.parse(trimmed) as unknown, records, depth + 1); } catch { /* Non-JSON text is ignored. */ }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, records, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  const normalizedKeys = Object.keys(object).map((key) => key.toLowerCase());
  if (normalizedKeys.some((key) => TITLE_KEYS.map((item) => item.toLowerCase()).includes(key))) {
    records.push(object);
    return;
  }

  const preferredKeys = ['jobs', 'results', 'items', 'data', 'joblist', 'job_list', 'opportunities', 'records', 'content'];
  let traversed = false;
  for (const key of preferredKeys) {
    if (key in object) {
      collectCandidates(object[key], records, depth + 1);
      traversed = true;
    }
  }
  if (!traversed) {
    for (const child of Object.values(object)) {
      if (child && (Array.isArray(child) || typeof child === 'object')) collectCandidates(child, records, depth + 1);
      else if (typeof child === 'string') collectCandidates(child, records, depth + 1);
    }
  }
}

export function normalizeJob(rawValue: unknown, source: string, profile: JobProfile): NormalizedJob | undefined {
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) return undefined;
  const raw = rawValue as Record<string, unknown>;
  const title = getString(raw, TITLE_KEYS);
  if (!title) return undefined;

  const company = getString(raw, COMPANY_KEYS);
  const location = getString(raw, LOCATION_KEYS);
  const jobUrl = normalizeUrl(getString(raw, ['jobUrl', 'job_url', 'externalUrl', 'external_url', 'url', 'link', 'jobLink', 'job_link']));
  const applicationUrl = normalizeUrl(getString(raw, ['applicationUrl', 'application_url', 'applyUrl', 'apply_url', 'applyLink', 'apply_link', 'careerUrl', 'career_url', 'job_url_direct', 'jobUrlDirect'])) ?? jobUrl;
  const sourceJobId = getString(raw, ID_KEYS);
  const identity = jobUrl ?? `${source}:${sourceJobId ?? ''}:${title}:${company ?? ''}:${location ?? ''}`;
  const id = createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 32);
  const { score, reasons } = calculateMatchScore(raw, title, location, profile);

  return {
    id,
    source,
    sourceJobId,
    title,
    company,
    location,
    country: getString(raw, ['country', 'countryName', 'country_name']),
    description: getString(raw, DESCRIPTION_KEYS),
    salary: getString(raw, ['salary', 'sal', 'salaryRange', 'salary_range', 'salaryText', 'salary_text', 'compensation', 'payRange', 'pay_range', 'remuneration']),
    jobUrl,
    applicationUrl,
    employmentType: getString(raw, ['employmentType', 'employment_type', 'jobType', 'job_type', 'type']),
    workMode: getString(raw, ['workMode', 'work_mode', 'workplace', 'workplaceType', 'workplace_type', 'remoteType']) ?? ((raw.remote === true || raw.is_remote === true) ? 'Remote' : ['jobicy', 'remoteok'].includes(source) ? 'Remote' : undefined),
    salaryMin: getNumber(raw, SALARY_MIN_KEYS),
    salaryMax: getNumber(raw, SALARY_MAX_KEYS),
    salaryCurrency: getString(raw, ['salaryCurrency', 'salary_currency', 'currency']),
    postedAt: getString(raw, POSTED_KEYS),
    experience: getString(raw, ['experience', 'experienceLevel', 'experience_level', 'jobLevel', 'job_level', 'yearsExperience', 'years_of_experience', 'experienceRange', 'experience_range', 'experience_level', 'seniorityLevel', 'seniority_level']),
    matchScore: score,
    matchReasons: reasons,
    raw,
  };
}

export function resolveRemoteOkApplicationUrl(listingUrl: string | undefined, directApplyUrl: unknown): string | undefined {
  if (typeof directApplyUrl !== 'string') return undefined;
  const normalized = normalizeUrl(directApplyUrl);
  if (!normalized) return undefined;
  try {
    const target = new URL(normalized);
    const listing = listingUrl ? new URL(listingUrl) : undefined;
    const host = target.hostname.toLowerCase();
    if (host === 'remoteok.com' || host.endsWith('.remoteok.com')) return undefined;
    if (listing && target.href.replace(/\/$/, '') === listing.href.replace(/\/$/, '')) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

export function calculateMatchScore(raw: Record<string, unknown>, title: string, location: string | undefined, profile: JobProfile): { score: number; reasons: string[] } {
  let score = 25;
  const reasons: string[] = [];
  const fullText = `${title} ${stringify(raw.description ?? raw.jobDescription ?? raw.summary ?? '')} ${stringify(raw.skills ?? raw.requirements ?? '')}`.toLowerCase();
  const desiredTerms = [...(profile.skills ?? []), ...(profile.keywords ?? [])].map((item) => item.toLowerCase()).filter(Boolean);
  const matchedSkills = desiredTerms.filter((term) => fullText.includes(term));
  if (matchedSkills.length) {
    score += Math.min(35, matchedSkills.length * 7);
    reasons.push(`Matches skills/keywords: ${matchedSkills.slice(0, 5).join(', ')}`);
  }
  const titleWords = profile.jobTitle.toLowerCase().split(/[^a-z0-9+#.]+/).filter((word) => word.length > 2);
  const titleMatches = titleWords.filter((word) => title.toLowerCase().includes(word)).length;
  if (titleWords.length && titleMatches > 0) {
    score += Math.round((titleMatches / titleWords.length) * 25);
    reasons.push('Job title matches your target role');
  }
  if (profile.location && location && location.toLowerCase().includes(profile.location.toLowerCase())) {
    score += 10;
    reasons.push('Location matches your preference');
  } else if (profile.remote === true && `${title} ${stringify(raw.workMode ?? raw.remote ?? '')}`.toLowerCase().includes('remote')) {
    score += 10;
    reasons.push('Remote work preference matches');
  }
  const rawSalaryMin = getNumber(raw, SALARY_MIN_KEYS);
  const rawSalaryMax = getNumber(raw, SALARY_MAX_KEYS);
  if (profile.salaryMin !== undefined && rawSalaryMax !== undefined && rawSalaryMax >= profile.salaryMin) {
    score += 5;
    reasons.push('Published salary overlaps your minimum');
  }
  if (profile.salaryMax !== undefined && rawSalaryMin !== undefined && rawSalaryMin <= profile.salaryMax) score += 5;
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function getString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (key in record) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.map(stringify).filter(Boolean).join(', ') || undefined;
      if (value && typeof value === 'object') {
        const nested = value as Record<string, unknown>;
        const nestedValue = getString(nested, ['name', 'label', 'value', 'text', 'city', 'country']);
        if (nestedValue) return nestedValue;
      }
    }
  }
  return undefined;
}

function getNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.replace(/[^\d.]/g, ''));
      if (Number.isFinite(parsed) && value.trim()) return parsed;
    }
  }
  return undefined;
}

function normalizeUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|tracking|trk|ref|source)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return ''; }
}
