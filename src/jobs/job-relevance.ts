import type { JobProfile, NormalizedJob } from '../common/job.types';

const ROLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'senior', 'junior', 'staff', 'principal', 'lead', 'head',
  'director', 'manager', 'associate', 'mid', 'level', 'remote', 'full', 'time',
  'developer', 'engineer', 'software', 'programmer', 'web', 'specialist', 'analyst',
  'scientist', 'consultant', 'professional', 'executive',
]);

function normalize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(value: unknown): string[] {
  return normalize(value).split(' ').filter((part) => part.length > 1);
}

function roleFamily(value: unknown): string | undefined {
  const role = normalize(value);
  if (/\b(customer support|customer service|technical support|support engineer|help desk|helpdesk|service desk)\b/.test(role)) return 'support';
  if (/\b(devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer|systems engineer|cloud operations)\b/.test(role)) return 'devops';
  if (/\b(data scientist|machine learning scientist|research scientist|applied scientist)\b/.test(role)) return 'data-science';
  if (/\b(data engineer|analytics engineer|data platform engineer)\b/.test(role)) return 'data-engineering';
  if (/\b(data analyst|business intelligence|bi analyst|reporting analyst)\b/.test(role)) return 'data-analytics';
  if (/\b(machine learning|ml engineer|ai engineer|artificial intelligence|llm engineer|deep learning|computer vision|nlp engineer)\b/.test(role)) return 'ai-ml';
  if (/\b(qa|quality assurance|test automation|automation tester|software tester|test engineer)\b/.test(role)) return 'qa-testing';
  if (/\b(product manager|product owner|product management)\b/.test(role)) return 'product';
  if (/\b(project manager|program manager|project coordinator|scrum master)\b/.test(role)) return 'project-program';
  if (/\b(ux designer|ui designer|product designer|graphic designer|visual designer|design researcher|ux researcher)\b/.test(role)) return 'design';
  if (/\b(marketing|seo|content writer|copywriter|growth marketer|social media|communications)\b/.test(role)) return 'marketing';
  if (/\b(sales|account executive|business development|sales development|account manager)\b/.test(role)) return 'sales';
  if (/\b(recruiter|talent acquisition|human resources|hr manager|people operations|hr business partner)\b/.test(role)) return 'human-resources';
  if (/\b(accountant|accounting|financial analyst|finance manager|bookkeeper|payroll)\b/.test(role)) return 'finance';
  if (/\b(legal counsel|lawyer|paralegal|compliance officer)\b/.test(role)) return 'legal';
  if (/\b(backend|back end|frontend|front end|full stack|fullstack|software|developer|programmer|web engineer|web developer|application engineer|mobile developer|ios developer|android developer|firmware engineer|embedded engineer)\b/.test(role)) return 'software-engineering';
  return undefined;
}

function roleAliases(term: string): string[] {
  const aliases: Record<string, string[]> = {
    backend: ['backend', 'back end', 'back-end', 'server side', 'api'],
    frontend: ['frontend', 'front end', 'front-end', 'ui developer'],
    fullstack: ['fullstack', 'full stack', 'full-stack'],
    'node.js': ['node.js', 'nodejs', 'node'],
    node: ['node.js', 'nodejs', 'node'],
    react: ['react', 'reactjs', 'react.js'],
    javascript: ['javascript', 'js'],
    typescript: ['typescript', 'ts'],
    golang: ['golang', 'go language'],
    devops: ['devops', 'site reliability', 'sre', 'platform engineer'],
    qa: ['qa', 'quality assurance', 'test automation', 'test engineer'],
    'data engineer': ['data engineer', 'analytics engineer'],
    'data analyst': ['data analyst', 'business intelligence', 'bi analyst'],
    'machine learning': ['machine learning', 'ml engineer', 'ai engineer'],
  };
  return aliases[term] ?? [term];
}

function rawRoleEvidence(raw: Record<string, unknown> | undefined): string {
  if (!raw) return '';
  const nested = raw.raw && typeof raw.raw === 'object' ? raw.raw as Record<string, unknown> : undefined;
  const values = [
    raw.tags, raw.tag, raw.category, raw.categories, raw.parentCategories, raw.parent_categories,
    raw.role, raw.jobRole, raw.job_role, raw.skills, raw.technology,
    nested?.tags, nested?.tag, nested?.category, nested?.categories, nested?.parentCategories,
    nested?.parent_categories, nested?.role, nested?.jobRole, nested?.job_role, nested?.skills,
  ];
  return values.map((value) => {
    if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(' ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value ?? '');
  }).join(' ');
}

export function matchesJobTitle(title: string, raw: Record<string, unknown> | undefined, targetTitle: string): boolean {
  if (!title.trim() || !targetTitle.trim()) return false;
  const target = normalize(targetTitle);
  const searchable = normalize(title + ' ' + rawRoleEvidence(raw));
  const targetFamily = roleFamily(target);
  const jobFamily = roleFamily(title);

  if (targetFamily && jobFamily && targetFamily !== jobFamily) return false;

  const targetSpecificTerms = [...new Set(tokens(target).filter((term) => !ROLE_STOPWORDS.has(term)))];
  if (targetSpecificTerms.length) {
    const matched = targetSpecificTerms.filter((term) => roleAliases(term).some((alias) => searchable.includes(normalize(alias))));
    const required = targetSpecificTerms.length > 2 ? Math.ceil(targetSpecificTerms.length * 0.5) : 1;
    return matched.length >= required;
  }

  if (targetFamily) return jobFamily === targetFamily;
  const queryTerms = tokens(target);
  return queryTerms.length > 0 && queryTerms.some((term) => searchable.includes(term));
}

function regionsIn(value: unknown): string[] {
  const s = normalize(value);
  const patterns: Array<[string, RegExp]> = [
    ['latin-america', /\b(latin america|latam|south america|central america|brazil|argentina|mexico|colombia|chile|peru)\b/],
    ['apac', /\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|asia|apac|singapore|australia|japan|new zealand|philippines|pakistan|nepal|sri lanka|indonesia|thailand|vietnam|hong kong|malaysia)\b/],
    ['europe', /\b(europe|united kingdom|uk|london|germany|berlin|france|paris|netherlands|amsterdam|ireland|dublin|spain|italy|poland|sweden|norway|finland|portugal|switzerland|austria|belgium|denmark)\b/],
    ['north-america', /\b(usa|united states|america|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles|canada|toronto|vancouver|north america)\b/],
    ['middle-east', /\b(middle east|uae|united arab emirates|dubai|saudi arabia|qatar|kuwait|bahrain|oman)\b/],
    ['africa', /\b(africa|south africa|nigeria|kenya|egypt|ghana)\b/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(s)).map(([region]) => region);
}

function countriesIn(value: unknown): string[] {
  const s = normalize(value);
  const checks: Array<[string, RegExp]> = [
    ['india', /\b(india|bengaluru|bangalore|delhi|delhi ncr|mumbai|hyderabad|chennai|pune|kolkata|noida|gurugram|gurgaon)\b/],
    ['australia', /\b(australia|sydney|melbourne|perth|brisbane|adelaide)\b/],
    ['new-zealand', /\b(new zealand|auckland|wellington)\b/],
    ['singapore', /\bsingapore\b/],
    ['japan', /\b(japan|tokyo|osaka)\b/],
    ['philippines', /\b(philippines|manila)\b/],
    ['pakistan', /\b(pakistan|karachi|lahore|islamabad)\b/],
    ['nepal', /\bnepal\b/],
    ['sri-lanka', /\b(sri lanka|colombo)\b/],
    ['indonesia', /\b(indonesia|jakarta)\b/],
    ['thailand', /\bthailand\b/],
    ['vietnam', /\bvietnam\b/],
    ['malaysia', /\bmalaysia\b/],
    ['hong-kong', /\bhong kong\b/],
    ['united-kingdom', /\b(united kingdom|uk|england|scotland|wales|london|manchester|birmingham)\b/],
    ['germany', /\b(germany|berlin|munich|frankfurt|hamburg)\b/],
    ['france', /\b(france|paris|lyon)\b/],
    ['netherlands', /\b(netherlands|amsterdam|rotterdam|utrecht)\b/],
    ['ireland', /\b(ireland|dublin|cork)\b/],
    ['spain', /\b(spain|madrid|barcelona)\b/],
    ['italy', /\b(italy|rome|milan)\b/],
    ['poland', /\b(poland|warsaw|krakow)\b/],
    ['sweden', /\bsweden\b/],
    ['norway', /\bnorway\b/],
    ['finland', /\bfinland\b/],
    ['portugal', /\bportugal|lisbon\b/],
    ['switzerland', /\b(switzerland|zurich|geneva)\b/],
    ['austria', /\baustria\b/],
    ['belgium', /\bbelgium\b/],
    ['denmark', /\bdenmark\b/],
    ['united-states', /\b(united states|usa|u s a|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles)\b/],
    ['canada', /\b(canada|toronto|vancouver|montreal|calgary|ottawa|edmonton)\b/],
    ['brazil', /\b(brazil|sao paulo|rio de janeiro)\b/],
    ['mexico', /\bmexico\b/],
    ['argentina', /\bargentina\b/],
    ['colombia', /\bcolombia\b/],
    ['chile', /\bchile\b/],
    ['south-africa', /\b(south africa|johannesburg|cape town)\b/],
    ['nigeria', /\bnigeria\b/],
    ['kenya', /\bkenya\b/],
    ['egypt', /\begypt\b/],
    ['united-arab-emirates', /\b(united arab emirates|uae|dubai|abu dhabi)\b/],
    ['saudi-arabia', /\b(saudi arabia|riyadh|jeddah)\b/],
  ];
  return checks.filter(([, pattern]) => pattern.test(s)).map(([country]) => country);
}

function isExplicitGlobalEligibility(value: unknown): boolean {
  return /\b(available worldwide|worldwide eligible|work from anywhere|remote from anywhere|remote worldwide|anywhere in the world|open to candidates worldwide|eligible in all countries|remote from any location)\b/i.test(String(value ?? ''));
}

function isGlobal(value: unknown): boolean {
  return /\b(worldwide|anywhere|global|all countries|work from anywhere|remote worldwide|world wide)\b/i.test(String(value ?? ''));
}

function locationFields(job: NormalizedJob): string[] {
  const raw = job.raw ?? {};
  const nested = raw.raw && typeof raw.raw === 'object' ? raw.raw as Record<string, unknown> : undefined;
  const values = [
    job.location, job.country, raw.city, raw.country, raw.country_name, raw.location_country, raw.region,
    raw.locationRestrictions, raw.location_restrictions, raw.allowedCountries, raw.allowed_countries,
    raw.locations, raw.geography, raw.geographies,
    nested?.city, nested?.country, nested?.country_name, nested?.location_country, nested?.region,
    nested?.locationRestrictions, nested?.location_restrictions, nested?.allowedCountries,
  ];
  return values.map((value) => {
    if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join(', ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value ?? '');
  }).filter(Boolean);
}

function matchesOneLocation(job: NormalizedJob, target: string): boolean {
  if (/^(remote|worldwide|global|anywhere|all locations|all countries)$/i.test(target)) return true;
  const structured = locationFields(job).join(' ');
  if (isGlobal(structured)) return true;

  const targetNormalized = normalize(target);
  const structuredNormalized = normalize(structured);
  if (structuredNormalized && structuredNormalized.includes(targetNormalized)) return true;

  const targetCountries = countriesIn(target);
  const jobCountries = countriesIn(structured);
  if (targetCountries.length && jobCountries.length) {
    return targetCountries.some((country) => jobCountries.includes(country));
  }

  const targetRegions = regionsIn(target);
  const jobRegions = regionsIn(structured);
  if (targetRegions.length && jobRegions.length) {
    return targetRegions.some((region) => jobRegions.includes(region));
  }

  const description = String(job.description ?? job.raw?.description ?? job.raw?.excerpt ?? '');
  if (isExplicitGlobalEligibility(description)) return true;

  if (structuredNormalized) {
    const wanted = tokens(target).filter((term) => term.length > 2);
    const offered = new Set(tokens(structured));
    if (wanted.some((term) => offered.has(term))) return true;
    return false;
  }

  const restriction = description.match(/(?:based in|based out of|located in|must be (?:located|based|resident) in|residing in|residing within|candidates? (?:must|should) be (?:located|based) in|only available in|available only in|position is restricted to)\s+([^.<\n]{2,70})/i);
  if (restriction) {
    const allowed = normalize(restriction[1]);
    const requested = normalize(target);
    const allowedRegions = regionsIn(allowed);
    if (targetRegions.length && allowedRegions.length) return targetRegions.some((region) => allowedRegions.includes(region));
    return allowed.includes(requested) || requested.includes(allowed);
  }

  return false;
}

export function matchesJobLocation(job: NormalizedJob, profile: JobProfile): boolean {
  const location = String(profile.location ?? '').trim();
  if (location) return matchesOneLocation(job, location);

  const countries = (profile.countries ?? []).map((value) => value.trim())
    .filter((value) => value && !/^(worldwide|global|anywhere|remote|all countries)$/i.test(value));
  if (!countries.length) return false;
  return countries.some((country) => matchesOneLocation(job, country));
}
