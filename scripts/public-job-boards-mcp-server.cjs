#!/usr/bin/env node
const readline = require('node:readline');

const CACHE_TTL_MS = 30 * 60 * 1000;
const SOURCE = process.argv[2];
const SOURCE_CONFIG = {
  arbeitnow: {
    label: 'Arbeitnow',
    remoteOnly: false,
    maxPages: 4,
    cacheSeconds: 1800
  },
  workingnomads: {
    label: 'Working Nomads',
    remoteOnly: true,
    maxPages: 1,
    cacheSeconds: 1800
  },
  himalayas: {
    label: 'Himalayas',
    remoteOnly: true,
    maxPages: 5,
    cacheSeconds: 1800
  },
  remotive: {
    label: 'Remotive',
    remoteOnly: true,
    maxPages: 1,
    cacheSeconds: 21600
  },
  weworkremotely: {
    label: 'We Work Remotely',
    remoteOnly: true,
    maxPages: 1,
    cacheSeconds: 3600
  },
  greenhouse: {
    label: 'Greenhouse company career boards',
    remoteOnly: false,
    maxPages: 1,
    cacheSeconds: 900
  },
  lever: {
    label: 'Lever company career boards',
    remoteOnly: false,
    maxPages: 1,
    cacheSeconds: 900
  },
  ashby: {
    label: 'Ashby company career boards',
    remoteOnly: false,
    maxPages: 1,
    cacheSeconds: 900
  },
  adzuna: {
    label: 'Adzuna',
    remoteOnly: false,
    maxPages: 1,
    cacheSeconds: 300
  },
  jooble: {
    label: 'Jooble',
    remoteOnly: false,
    maxPages: 1,
    cacheSeconds: 300
  }
};

if (!SOURCE_CONFIG[SOURCE] && require.main === module) {
  process.stderr.write('Set source to a supported provider in the MCP command arguments.\\n');
  process.exit(2);
}

const cache = new Map();
const inFlight = new Map();

const tools = [{
  name: 'search_jobs',
  description: 'Search live public job listings from ' + (SOURCE_CONFIG[SOURCE]?.label || 'configured provider') + ' using a target title and preferred location. Returns provider links and excludes listings without enough matching evidence.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Target job title' },
      location: { type: 'string', description: 'Required city, country, region, Remote, or Worldwide preference' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      skills: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } }
    },
    required: ['query', 'location']
  }
}];

function text(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(text).filter(Boolean).join(' ');
  return '';
}

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9+#.]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value) {
  return normalize(value).split(' ').filter((part) => part.length > 1);
}

const ROLE_STOP = new Set(['the', 'and', 'for', 'with', 'senior', 'junior', 'staff', 'principal', 'lead', 'head', 'director', 'manager', 'associate', 'mid', 'level', 'remote', 'full', 'time', 'developer', 'engineer', 'software', 'programmer', 'web', 'specialist', 'analyst', 'scientist', 'consultant', 'professional', 'executive']);

function roleFamily(value) {
  const s = normalize(value);
  if (/\b(customer support|customer service|technical support|support engineer|help desk|helpdesk|service desk)\b/.test(s)) return 'support';
  if (/\b(devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer|systems engineer|cloud operations)\b/.test(s)) return 'devops';
  if (/\b(data scientist|machine learning scientist|research scientist|applied scientist)\b/.test(s)) return 'data-science';
  if (/\b(data engineer|analytics engineer|data platform engineer)\b/.test(s)) return 'data-engineering';
  if (/\b(data analyst|business intelligence|bi analyst|reporting analyst)\b/.test(s)) return 'data-analytics';
  if (/\b(machine learning|ml engineer|ai engineer|artificial intelligence|llm engineer|deep learning|computer vision|nlp engineer)\b/.test(s)) return 'ai-ml';
  if (/\b(qa|quality assurance|test automation|automation tester|software tester|test engineer)\b/.test(s)) return 'qa-testing';
  if (/\b(product manager|product owner|product management)\b/.test(s)) return 'product';
  if (/\b(project manager|program manager|project coordinator|scrum master)\b/.test(s)) return 'project-program';
  if (/\b(ux designer|ui designer|product designer|graphic designer|visual designer|design researcher|ux researcher)\b/.test(s)) return 'design';
  if (/\b(marketing|seo|content writer|copywriter|growth marketer|social media|communications)\b/.test(s)) return 'marketing';
  if (/\b(sales|account executive|business development|sales development|account manager)\b/.test(s)) return 'sales';
  if (/\b(recruiter|talent acquisition|human resources|hr manager|people operations|hr business partner)\b/.test(s)) return 'human-resources';
  if (/\b(accountant|accounting|financial analyst|finance manager|bookkeeper|payroll)\b/.test(s)) return 'finance';
  if (/\b(legal counsel|lawyer|paralegal|compliance officer)\b/.test(s)) return 'legal';
  if (/\b(backend|back end|frontend|front end|full stack|fullstack|software|developer|programmer|web engineer|web developer|application engineer|mobile developer|ios developer|android developer|firmware engineer|embedded engineer)\b/.test(s)) return 'software-engineering';
  if (/\b(recruiter|talent acquisition)\b/.test(s)) return 'human-resources';
  return undefined;
}

function aliasesFor(term) {
  const aliases = {
    backend: ['backend', 'back end', 'back-end', 'server side', 'api'],
    frontend: ['frontend', 'front end', 'front-end', 'ui developer'],
    fullstack: ['fullstack', 'full stack', 'full-stack'],
    'node.js': ['node.js', 'nodejs', 'node'],
    node: ['node.js', 'nodejs', 'node'],
    react: ['react', 'reactjs', 'react.js'],
    javascript: ['javascript', 'js', 'typescript', 'ts'],
    typescript: ['typescript', 'ts', 'javascript'],
    java: ['java'],
    python: ['python'],
    golang: ['golang', 'go language'],
    devops: ['devops', 'site reliability', 'sre', 'platform engineer'],
    qa: ['qa', 'quality assurance', 'test automation', 'test engineer'],
    'data engineer': ['data engineer', 'analytics engineer'],
    'data analyst': ['data analyst', 'business intelligence', 'bi analyst'],
    'machine learning': ['machine learning', 'ml engineer', 'ai engineer']
  };
  return aliases[term] || [term];
}

function matchesRole(job, query) {
  const title = text(job.title || job.position || job.jobTitle || job.job_title || job.role);
  if (!title) return false;
  const tags = text(job.tags || job.categories || job.parentCategories || job.parent_categories);
  const titleAndTags = normalize(title + ' ' + tags);
  const queryNormalized = normalize(query);
  if (!queryNormalized) return false;

  const targetFamily = roleFamily(queryNormalized);
  const titleFamily = roleFamily(title);
  if (targetFamily && titleFamily && targetFamily !== titleFamily) return false;

  const queryTokens = tokens(queryNormalized).filter((term) => !ROLE_STOP.has(term));
  const targetCore = [...new Set(queryTokens)];
  if (targetCore.length > 0) {
    const matched = targetCore.filter((term) => aliasesFor(term).some((alias) => titleAndTags.includes(normalize(alias))));
    const requiredMatches = targetCore.length > 2 ? Math.ceil(targetCore.length * 0.5) : 1;
    return matched.length >= requiredMatches && (!targetFamily || !titleFamily || targetFamily === titleFamily);
  }

  if (targetFamily) return titleFamily === targetFamily;
  const targetTerms = tokens(queryNormalized);
  return targetTerms.length > 0 && targetTerms.some((term) => titleAndTags.includes(term));
}

function regionFor(value) {
  const s = normalize(value);
  if (/\b(latin america|latam|south america|central america|brazil|argentina|mexico|colombia|chile|peru)\b/.test(s)) return 'latin-america';
  if (/\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|asia|apac|singapore|australia|japan|new zealand|philippines|pakistan|nepal|sri lanka|indonesia|thailand|vietnam|hong kong|malaysia)\b/.test(s)) return 'apac';
  if (/\b(europe|united kingdom|uk|london|germany|berlin|france|paris|netherlands|amsterdam|ireland|dublin|spain|italy|poland|sweden|norway|finland|portugal|switzerland|austria|belgium|denmark)\b/.test(s)) return 'europe';
  if (/\b(usa|united states|america|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles|canada|toronto|vancouver|north america)\b/.test(s)) return 'north-america';
  if (/\b(middle east|uae|united arab emirates|dubai|saudi arabia|qatar|kuwait|bahrain|oman)\b/.test(s)) return 'middle-east';
  if (/\b(africa|south africa|nigeria|kenya|egypt|ghana)\b/.test(s)) return 'africa';
  return undefined;
}

function countriesFor(value) {
  const s = normalize(value);
  const checks = [
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
    ['portugal', /\b(portugal|lisbon)\b/],
    ['switzerland', /\b(switzerland|zurich|geneva)\b/],
    ['austria', /\baustria\b/],
    ['belgium', /\bbelgium\b/],
    ['denmark', /\bdenmark\b/],
    ['united-states', /\b(united states|usa|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles)\b/],
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

function isExplicitGlobalEligibility(value) {
  return /\b(available worldwide|worldwide eligible|work from anywhere|remote from anywhere|remote worldwide|anywhere in the world|open to candidates worldwide|eligible in all countries|remote from any location)\b/i.test(String(value || ''));
}
function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripMarkup(value) {
  return decodeXml(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlTag(value, tag) {
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const match = String(value || '').match(pattern);
  return match ? decodeXml(match[1]).trim() : '';
}

function parseWeWorkRemotelyRss(xml) {
  const jobs = [];
  const expression = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = expression.exec(String(xml || ''))) !== null) {
    const item = match[1];
    const rawTitle = stripMarkup(xmlTag(item, 'title'));
    const url = stripMarkup(xmlTag(item, 'link'));
    const description = stripMarkup(xmlTag(item, 'description'));
    const postedAt = stripMarkup(xmlTag(item, 'pubDate'));
    const categories = [...item.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
      .map((category) => stripMarkup(category[1]))
      .filter(Boolean);
    const separator = rawTitle.indexOf(':');
    const company = separator > 0 && separator < 90 ? rawTitle.slice(0, separator).trim() : '';
    const title = company ? rawTitle.slice(separator + 1).trim() : rawTitle;
    if (!title || !/^https?:\/\//i.test(url)) continue;
    jobs.push({
      id: url,
      title,
      company,
      location: isExplicitGlobalEligibility(description) ? 'Worldwide' : '',
      description,
      tags: categories,
      workMode: 'Remote',
      postedAt,
      url,
      source: 'weworkremotely',
    });
  }
  return jobs;
}

function countryCodeFor(value) {
  const s = normalize(value);
  const checks = [
    ['IN', /\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|noida|gurugram|gurgaon)\b/],
    ['US', /\b(united states|usa|new york|san francisco|california|texas|seattle|austin|chicago|boston|los angeles)\b/],
    ['GB', /\b(united kingdom|uk|england|scotland|wales|london|manchester|birmingham)\b/],
    ['CA', /\b(canada|toronto|vancouver|montreal|calgary|ottawa|edmonton)\b/],
    ['AU', /\b(australia|sydney|melbourne|perth|brisbane|adelaide)\b/],
    ['DE', /\b(germany|berlin|munich|frankfurt|hamburg)\b/],
    ['FR', /\b(france|paris|lyon)\b/],
    ['SG', /\bsingapore\b/],
    ['AE', /\b(united arab emirates|uae|dubai|abu dhabi)\b/],
    ['NZ', /\b(new zealand|auckland|wellington)\b/],
    ['PK', /\b(pakistan|karachi|lahore|islamabad)\b/],
    ['BD', /\b(bangladesh|dhaka)\b/],
    ['NG', /\b(nigeria|lagos|abuja)\b/],
    ['ZA', /\b(south africa|johannesburg|cape town)\b/],
    ['IE', /\b(ireland|dublin|cork)\b/],
  ];
  return checks.find(([, pattern]) => pattern.test(s))?.[0];
}

function configuredBoards(environmentKey) {
  return [...new Set(String(process.env[environmentKey] || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)))].slice(0, 40);
}

function displayLocation(job, remoteFallback = false) {
  const primary = text(job.location || job.city || job.job_location);
  const restriction = text(job.locationRestrictions || job.location_restrictions || job.allowedCountries || job.allowed_countries || job.eligibleLocations || job.eligible_locations || job.location_country || job.country);
  if (SOURCE === 'himalayas' && Array.isArray(job.locationRestrictions) && job.locationRestrictions.length === 0) return 'Worldwide';
  if (primary && !/^(remote|remote only|remote eligible|remote · eligibility not stated)$/i.test(primary)) return primary;
  if (restriction) return primary ? primary + ' · ' + restriction : restriction;
  if (isExplicitGlobalEligibility(job.description || job.excerpt || job.summary)) return 'Worldwide';
  return primary || (remoteFallback ? 'Remote · eligibility not stated' : '');
}


function isGlobal(value) {
  return /\b(worldwide|anywhere|global|all countries|work from anywhere|remote worldwide|world wide)\b/i.test(text(value));
}

function locationEvidence(job) {
  const fields = [
    job.location, job.city, job.country, job.country_name, job.location_country, job.region,
    job.locationRestrictions, job.location_restrictions, job.allowedCountries, job.allowed_countries,
    job.locations, job.geography, job.geographies
  ];
  return fields.map(text).filter(Boolean).join(' ');
}

function matchesLocation(job, requested, remoteOnly = false) {
  const target = String(requested || '').trim();
  const remoteJob = remoteOnly || job.remote === true || job.is_remote === true || /\bremote\b/i.test(text(job.workMode || job.work_mode || job.workplace));
  if (!target) return false;
  if (/^(remote|worldwide|global|anywhere|all locations|all countries)$/i.test(target)) return true;
  if (SOURCE === 'himalayas' && Array.isArray(job.locationRestrictions) && job.locationRestrictions.length === 0) return true;

  const structured = locationEvidence(job);
  if (isGlobal(structured)) return true;

  const requestedNormalized = normalize(target);
  const structuredNormalized = normalize(structured);
  if (structuredNormalized && structuredNormalized.includes(requestedNormalized)) return true;

  const targetCountries = countriesFor(target);
  const jobCountries = countriesFor(structured);
  if (targetCountries.length && jobCountries.length) {
    return targetCountries.some((country) => jobCountries.includes(country));
  }
  const targetRegion = regionFor(target);
  const jobRegion = regionFor(structured);
  if (targetRegion && jobRegion) return targetRegion === jobRegion;

  const description = text(job.description || job.excerpt || job.summary);
  if (isExplicitGlobalEligibility(description)) return true;

  if (structuredNormalized) {
    const wanted = tokens(target).filter((term) => term.length > 2);
    const offered = new Set(tokens(structured));
    if (wanted.some((term) => offered.has(term))) return true;
    return remoteJob;
  }

  const restriction = description.match(/(?:based in|based out of|located in|must be (?:located|based|resident) in|residing in|residing within|candidates? (?:must|should) be (?:located|based) in|only available in|available only in|position is restricted to)\s+([^.<\n]{2,70})/i);
  if (restriction) {
    const requestedCountries = countriesFor(target);
    const restrictedCountries = countriesFor(restriction[1]);
    if (requestedCountries.length && restrictedCountries.length) {
      return requestedCountries.some((country) => restrictedCountries.includes(country));
    }
    const restricted = regionFor(restriction[1]) || normalize(restriction[1]);
    const requestedRegion = targetRegion || requestedNormalized;
    return Boolean(restricted && requestedRegion && (restricted === requestedRegion || String(restricted).includes(requestedRegion) || requestedRegion.includes(String(restricted))));
  }
  const mentionedRegions = ['latin-america', 'apac', 'europe', 'north-america', 'middle-east', 'africa'];
  const descriptionRegion = regionFor(description);
  if (targetRegion && descriptionRegion) return targetRegion === descriptionRegion;
  if (remoteJob) return true;
  return false;
}

function mapJob(job) {
  if (SOURCE === 'adzuna') {
    const countryCode = String(process.env.ADZUNA_COUNTRY || 'in').toLowerCase();
    const currency = ({ in: 'INR', gb: 'GBP', us: 'USD', ca: 'CAD', au: 'AUD', de: 'EUR', fr: 'EUR', nz: 'NZD' })[countryCode];
    return {
      id: text(job.id || job.redirect_url),
      title: text(job.title),
      company: text(job.company?.display_name || job.company),
      location: text(job.location?.display_name || job.location),
      country: countryCode.toUpperCase(),
      description: text(job.description),
      tags: text(job.category?.label || job.category?.tag || job.category),
      employmentType: text(job.contract_type || job.contract_time),
      workMode: 'On-site / Hybrid / not specified',
      salaryMin: typeof job.salary_min === 'number' ? job.salary_min : undefined,
      salaryMax: typeof job.salary_max === 'number' ? job.salary_max : undefined,
      salaryCurrency: currency,
      postedAt: text(job.created),
      url: text(job.redirect_url || job.url),
      source: 'adzuna',
      raw: job
    };
  }
  if (SOURCE === 'jooble') {
    return {
      id: text(job.id || job.link),
      title: text(job.title),
      company: text(job.company),
      location: displayLocation(job, false),
      description: text(job.snippet || job.description),
      tags: text(job.type || job.category),
      employmentType: text(job.type),
      salary: text(job.salary),
      postedAt: text(job.updated),
      url: text(job.link || job.url),
      source: 'jooble',
      raw: job
    };
  }
  if (SOURCE === 'greenhouse') {
    const location = text(job.location?.name || job.location || job.offices);
    return {
      id: text(job.id || job.requisition_id || job.absolute_url),
      title: text(job.title),
      company: text(job._boardToken || job.company_name || job.company),
      location,
      description: text(job.content || job.description),
      tags: [job.departments, job.offices].map(text).filter(Boolean).join(' '),
      postedAt: text(job.updated_at),
      url: text(job.absolute_url || job.url),
      applicationUrl: text(job.absolute_url || job.url),
      source: 'greenhouse',
      raw: job
    };
  }
  if (SOURCE === 'lever') {
    const categories = job.categories && typeof job.categories === 'object' ? job.categories : {};
    return {
      id: text(job.id || job.hostedUrl),
      title: text(job.text || job.title),
      company: text(job._boardToken || job.company || job.companyName),
      location: text(categories.location || job.location),
      description: text(job.descriptionPlain || job.description || job.additional),
      tags: [categories.team, categories.department, categories.commitment].map(text).filter(Boolean).join(' '),
      employmentType: text(categories.commitment || job.workplaceType),
      workMode: text(job.workplaceType),
      postedAt: text(job.createdAt),
      url: text(job.hostedUrl || job.url),
      applicationUrl: text(job.applyUrl),
      source: 'lever',
      raw: job
    };
  }
  if (SOURCE === 'ashby') {
    return {
      id: text(job.jobUrl || job.applyUrl || job.id),
      title: text(job.title),
      company: text(job._boardToken || job.companyName || job.company),
      location: displayLocation(job, true),
      country: text(job.address?.postalAddress?.addressCountry || job.country),
      description: text(job.descriptionPlain || job.descriptionHtml || job.description),
      tags: [job.department, job.team, job.seniority].map(text).filter(Boolean).join(' '),
      employmentType: text(job.employmentType),
      workMode: job.isRemote === true ? 'Remote' : text(job.workplaceType),
      postedAt: text(job.publishedAt || job.updatedAt),
      url: text(job.jobUrl || job.url),
      applicationUrl: text(job.applyUrl),
      source: 'ashby',
      raw: job
    };
  }
  if (SOURCE === 'arbeitnow') {
    return {
      id: text(job.slug || job.id),
      title: text(job.title),
      company: text(job.company_name || job.company),
      location: text(job.location),
      country: text(job.country),
      description: text(job.description),
      tags: Array.isArray(job.tags) ? job.tags : [],
      employmentType: text(job.job_types),
      workMode: job.remote === true ? 'Remote' : 'On-site / Hybrid / not specified',
      postedAt: text(job.created_at),
      url: text(job.url),
      source: 'arbeitnow',
      raw: job
    };
  }
  if (SOURCE === 'workingnomads') {
    return {
      id: text(job.id || job.slug || job.url),
      title: text(job.title),
      company: text(job.company || job.company_name || job.companyName),
      location: displayLocation(job, true),
      country: text(job.country || job.location_country || job.location_restrictions),
      description: text(job.description || job.excerpt),
      tags: [job.category, job.category_name, job.tags, job.skills].map(text).filter(Boolean).join(' '),
      employmentType: text(job.job_type || job.job_type_name || job.type),
      workMode: 'Remote',
      postedAt: text(job.pub_date || job.published_at || job.created_at || job.date),
      url: text(job.url || job.job_url),
      source: 'workingnomads',
      raw: job
    };
  }
  if (SOURCE === 'remotive') {
    return {
      id: text(job.id || job.url),
      title: text(job.title),
      company: text(job.company_name || job.company),
      location: text(job.candidate_required_location || job.location),
      description: text(job.description || job.excerpt),
      tags: [job.category, job.tags, job.job_type].map(text).filter(Boolean).join(' '),
      employmentType: text(job.job_type),
      workMode: 'Remote',
      postedAt: text(job.publication_date || job.created_at),
      url: text(job.url),
      source: 'remotive',
      raw: job
    };
  }
  if (SOURCE === 'weworkremotely') {
    return {
      id: text(job.id || job.url),
      title: text(job.title),
      company: text(job.company),
      location: displayLocation(job, true),
      description: text(job.description),
      tags: text(job.tags),
      employmentType: text(job.employmentType),
      workMode: 'Remote',
      postedAt: text(job.postedAt),
      url: text(job.url),
      source: 'weworkremotely',
      raw: job
    };
  }
  return {
    id: text(job.guid || job.id || job.slug),
    title: text(job.title),
    company: text(job.companyName || job.company_name || job.company),
    location: displayLocation(job, true),
    country: Array.isArray(job.locationRestrictions) ? job.locationRestrictions.join(', ') : text(job.country),
    description: text(job.description || job.excerpt),
    tags: [job.categories, job.parentCategories, job.seniority].map(text).filter(Boolean).join(' '),
    employmentType: text(job.employmentType),
    workMode: 'Remote',
    postedAt: text(job.pubDate || job.publishedAt || job.created_at),
    url: text(job.guid || job.url || job.jobUrl),
    applicationUrl: text(job.applicationLink),
    source: 'himalayas',
    raw: job
  };
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml, */*',
      'user-agent': 'NvoidJobAgent/1.0 (+https://jobkar.in)',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(SOURCE_CONFIG[SOURCE].label + ' feed returned HTTP ' + response.status);
  return response.text();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'user-agent': 'NvoidJobAgent/1.0 (+https://jobkar.in)',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error(SOURCE_CONFIG[SOURCE].label + ' feed returned HTTP ' + response.status);
  return response.json();
}

async function fetchAllJobs(query, location) {
  const queryScoped = ['adzuna', 'jooble', 'himalayas', 'greenhouse', 'lever', 'ashby'].includes(SOURCE);
  const cacheKey = queryScoped ? SOURCE + '|' + normalize(query) + '|' + normalize(location) : SOURCE;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.jobs;
  if (cached) cache.delete(cacheKey);
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const pending = (async () => {
    const rawJobs = [];
    if (SOURCE === 'adzuna') {
      const appId = process.env.ADZUNA_APP_ID;
      const appKey = process.env.ADZUNA_APP_KEY;
      if (!appId || !appKey || appId.includes('\${') || appKey.includes('\${')) throw new Error('Adzuna requires ADZUNA_APP_ID and ADZUNA_APP_KEY in the worker environment.');
      const rawCountry = process.env.ADZUNA_COUNTRY || 'in';
      const country = rawCountry.startsWith(String.fromCharCode(36) + '{') ? 'in' : rawCountry.toLowerCase();
      const params = new URLSearchParams({
        app_id: appId,
        app_key: appKey,
        what: query,
        where: location,
        results_per_page: '50',
        sort_by: 'date'
      });
      const payload = await fetchJson('https://api.adzuna.com/v1/api/jobs/' + encodeURIComponent(country) + '/search/1?' + params.toString());
      if (!Array.isArray(payload.results)) throw new Error('Adzuna returned an unexpected response.');
      rawJobs.push(...payload.results);
    } else if (SOURCE === 'jooble') {
      const key = process.env.JOOBLE_API_KEY;
      if (!key || key.includes('\${')) throw new Error('Jooble requires JOOBLE_API_KEY in the worker environment.');
      const payload = await fetchJson('https://jooble.org/api/' + encodeURIComponent(key), {
        method: 'POST',
        body: JSON.stringify({ keywords: query, location, page: 1, ResultOnPage: 100 })
      });
      if (!Array.isArray(payload.jobs)) throw new Error('Jooble returned an unexpected response.');
      rawJobs.push(...payload.jobs);
    } else if (SOURCE === 'arbeitnow') {
      for (let page = 1; page <= SOURCE_CONFIG[SOURCE].maxPages; page++) {
        const payload = await fetchJson('https://www.arbeitnow.com/api/job-board-api?page=' + page);
        const data = Array.isArray(payload) ? payload : payload.data;
        if (!Array.isArray(data) || data.length === 0) break;
        rawJobs.push(...data);
        if (!payload.links?.next && payload.meta?.current_page && payload.meta?.last_page && payload.meta.current_page >= payload.meta.last_page) break;
      }
    } else if (SOURCE === 'workingnomads') {
      const payload = await fetchJson('https://www.workingnomads.com/api/exposed_jobs/');
      if (!Array.isArray(payload)) throw new Error('Working Nomads returned an unexpected response.');
      rawJobs.push(...payload);
    } else if (SOURCE === 'remotive') {
      const payload = await fetchJson('https://remotive.com/api/remote-jobs');
      if (!Array.isArray(payload.jobs)) throw new Error('Remotive returned an unexpected response.');
      rawJobs.push(...payload.jobs);
    } else if (SOURCE === 'weworkremotely') {
      rawJobs.push(...parseWeWorkRemotelyRss(await fetchText('https://weworkremotely.com/remote-jobs.rss')));
    } else if (SOURCE === 'himalayas') {
      for (let page = 1; page <= SOURCE_CONFIG[SOURCE].maxPages; page++) {
        const params = new URLSearchParams({ q: query, sort: 'recent', page: String(page) });
        const countryCode = countryCodeFor(location);
        if (countryCode) params.set('country', countryCode);
        const payload = await fetchJson('https://himalayas.app/jobs/api/search?' + params.toString());
        if (!Array.isArray(payload.jobs) || payload.jobs.length === 0) break;
        rawJobs.push(...payload.jobs);
        const totalCount = Number(payload.totalCount);
        if (Number.isFinite(totalCount) && page * payload.jobs.length >= totalCount) break;
      }
    } else if (['greenhouse', 'lever', 'ashby'].includes(SOURCE)) {
      const environmentKey = ({ greenhouse: 'GREENHOUSE_BOARDS', lever: 'LEVER_SITES', ashby: 'ASHBY_BOARDS' })[SOURCE];
      const boards = configuredBoards(environmentKey);
      if (boards.length === 0) throw new Error('Configure ' + environmentKey + ' as a comma-separated list of company board slugs in the worker .env.');
      const failures = [];
      for (let startIndex = 0; startIndex < boards.length; startIndex += 4) {
        const batch = boards.slice(startIndex, startIndex + 4);
        const results = await Promise.all(batch.map(async (board) => {
          try {
            let items;
            if (SOURCE === 'greenhouse') {
              const payload = await fetchJson('https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(board) + '/jobs?content=true');
              if (!Array.isArray(payload.jobs)) throw new Error('Greenhouse returned an unexpected response for board ' + board);
              items = payload.jobs;
            } else if (SOURCE === 'lever') {
              const payload = await fetchJson('https://api.lever.co/v0/postings/' + encodeURIComponent(board) + '?mode=json');
              if (!Array.isArray(payload)) throw new Error('Lever returned an unexpected response for board ' + board);
              items = payload;
            } else {
              const payload = await fetchJson('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(board) + '?includeCompensation=true&listedOnly=true');
              if (!Array.isArray(payload.jobs)) throw new Error('Ashby returned an unexpected response for board ' + board);
              items = payload.jobs.filter((job) => job.isListed !== false);
            }
            return { board, items: items.map((job) => ({ ...job, _boardToken: board })) };
          } catch (error) {
            return { board, items: [], error: error instanceof Error ? error.message : String(error) };
          }
        }));
        for (const result of results) {
          if (result.error) failures.push(result.board + ': ' + result.error);
          rawJobs.push(...result.items);
        }
      }
      if (rawJobs.length === 0 && failures.length > 0) {
        throw new Error('All ' + SOURCE + ' career boards failed: ' + failures.slice(0, 4).join('; '));
      }
      if (failures.length > 0) process.stderr.write(SOURCE + ' skipped ' + failures.length + ' unavailable board(s).\\n');
    } else {
      throw new Error('No fetch implementation exists for source ' + SOURCE + '.');
    }

    const deduped = new Map();
    for (const job of rawJobs) {
      if (!job || typeof job !== 'object') continue;
      const mapped = mapJob(job);
      if (!mapped.title || !mapped.url || !/^https?:\/\//i.test(mapped.url)) continue;
      const key = normalize(mapped.url).replace(/\/+$/, '');
      if (!deduped.has(key)) deduped.set(key, job);
    }
    const jobs = [...deduped.values()];
    cache.set(cacheKey, { jobs, expiresAt: Date.now() + SOURCE_CONFIG[SOURCE].cacheSeconds * 1000 });
    for (const [key, value] of cache) {
      if (value.expiresAt <= Date.now()) cache.delete(key);
    }
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return jobs;
  })();
  inFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(cacheKey);
  }
}

async function searchJobs(args) {
  const query = String(args.query || '').trim();
  const location = String(args.location || '').trim();
  if (!query || !location) throw new Error('Both target role and preferred location are required. Use Worldwide for a global search.');

  const rawJobs = await fetchAllJobs(query, location);
  const matching = rawJobs.filter((job) => matchesRole(job, query) && matchesLocation(job, location, SOURCE_CONFIG[SOURCE].remoteOnly));
  const limitNumber = Number(args.limit);
  const limit = Number.isFinite(limitNumber) ? Math.min(100, Math.max(1, Math.floor(limitNumber))) : 30;
  return matching.slice(0, limit).map(mapJob);
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const id = message.id;
  if (id === undefined || id === null || message.method.startsWith('notifications/')) return;
  if (message.method === 'initialize') {
    respond(id, { protocolVersion: message.params?.protocolVersion || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nvoid-' + SOURCE + '-source', version: '1.0.0' } });
    return;
  }
  if (message.method === 'ping') { respond(id, {}); return; }
  if (message.method === 'tools/list') { respond(id, { tools }); return; }
  if (message.method === 'tools/call') {
    if (message.params?.name !== 'search_jobs') {
      respondError(id, -32602, 'Unknown tool: ' + String(message.params?.name));
      return;
    }
    try {
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      const jobs = await searchJobs(args);
      const result = { jobs, source: SOURCE_CONFIG[SOURCE].label, returnedCount: jobs.length, cachedForSeconds: SOURCE_CONFIG[SOURCE].cacheSeconds };
      respond(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      respondError(id, -32000, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  respondError(id, -32601, 'Unsupported method: ' + message.method);
}

function start() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    try {
      void handle(JSON.parse(line)).catch((error) => process.stderr.write(SOURCE + ' MCP request failed: ' + (error instanceof Error ? error.message : String(error)) + '\n'));
    } catch {
      process.stderr.write('Ignored invalid JSON on ' + SOURCE + ' MCP input.\n');
    }
  });
}

if (require.main === module) start();
module.exports = { matchesRole, matchesLocation, roleFamily, regionFor, countriesFor, mapJob, displayLocation };
