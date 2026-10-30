#!/usr/bin/env node
const readline = require('node:readline');
const cache = new Map();
const pending = new Map();
const SOURCE = 'serper-search';

function envInt(name, fallback, min, max) {
  const raw = String(process.env[name] || '').trim();
  if (!raw || raw.includes('$' + '{')) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function clean(value) {
  return String(value || '').replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}
function norm(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function family(value) {
  const s=norm(value);
  if (/\b(customer support|customer service|technical support|help.?desk)\b/.test(s)) return 'support';
  if (/\b(devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer)\b/.test(s)) return 'devops';
  if (/\b(data scientist|machine learning scientist|applied scientist)\b/.test(s)) return 'data-science';
  if (/\b(data engineer|analytics engineer)\b/.test(s)) return 'data-engineering';
  if (/\b(data analyst|business intelligence|bi analyst)\b/.test(s)) return 'data-analytics';
  if (/\b(machine learning|ml engineer|ai engineer|artificial intelligence|llm engineer)\b/.test(s)) return 'ai-ml';
  if (/\b(qa|quality assurance|test automation|software tester|test engineer)\b/.test(s)) return 'qa';
  if (/\b(product manager|product owner)\b/.test(s)) return 'product';
  if (/\b(project manager|program manager|scrum master)\b/.test(s)) return 'project';
  if (/\b(ux designer|ui designer|product designer|graphic designer)\b/.test(s)) return 'design';
  if (/\b(marketing|seo|content writer|copywriter|growth marketer|social media)\b/.test(s)) return 'marketing';
  if (/\b(sales|account executive|business development)\b/.test(s)) return 'sales';
  if (/\b(recruiter|talent acquisition|human resources|hr manager)\b/.test(s)) return 'hr';
  if (/\b(accountant|accounting|financial analyst|finance manager)\b/.test(s)) return 'finance';
  if (/\b(legal counsel|lawyer|paralegal)\b/.test(s)) return 'legal';
  if (/\b(backend|back end|frontend|front end|full stack|fullstack|software|developer|programmer|web engineer|application engineer|mobile developer|ios developer|android developer)\b/.test(s)) return 'software';
  return undefined;
}
const STOP=new Set(['the','and','for','with','senior','junior','staff','principal','lead','head','director','manager','associate','mid','level','remote','full','time','developer','engineer','software','programmer','web','specialist','analyst','scientist','consultant','professional','executive','jobs','job','career','careers','hiring','position','opening','openings']);
function matchesRole(title, description, query) {
  const a=norm(title),d=norm(description),q=norm(query),tf=family(q),af=family(a);
  if(!a||(tf&&af&&tf!==af))return false;
  const terms=[...new Set(q.split(' ').filter(x=>x.length>1&&!STOP.has(x)))];
  if(!terms.length)return Boolean(tf&&af===tf);
  const aliases={backend:['back end','backend'],frontend:['front end','frontend'],react:['reactjs','react.js'],javascript:['typescript'],typescript:['javascript'],qa:['quality assurance']};
  const hits=terms.filter(t=>a.includes(t)||d.includes(t)||(aliases[t]||[]).some(x=>a.includes(x)||d.includes(x)));
  return hits.length >= (terms.length>2?Math.ceil(terms.length*.6):terms.length);
}
function country(value) {
  const s=norm(value),tests=[
    ['india',/\b(india|bengaluru|bangalore|delhi|mumbai|hyderabad|chennai|pune|kolkata|noida|gurugram|gurgaon)\b/],
    ['united states',/\b(united states|usa|new york|san francisco|california|texas|seattle|chicago|boston)\b/],
    ['canada',/\b(canada|toronto|vancouver|montreal)\b/],['united kingdom',/\b(united kingdom|uk|london|manchester)\b/],
    ['australia',/\b(australia|sydney|melbourne|brisbane)\b/],['germany',/\b(germany|berlin|munich)\b/],
    ['singapore',/\bsingapore\b/],['pakistan',/\b(pakistan|karachi|lahore)\b/]
  ];
  return tests.find(x=>x[1].test(s))?.[0];
}
function locationMatch(location, description, url, requested) {
  const target=String(requested||'').trim();
  if(/^(remote|worldwide|global|anywhere|all locations|all countries)$/i.test(target))return true;
  const targetNorm=norm(target),locationNorm=norm(location),e=norm([location,description,url].join(' '));
  if(/\b(worldwide|global|work from anywhere|remote worldwide|all countries|anywhere in the world)\b/.test(e))return true;
  if(targetNorm&&e.includes(targetNorm))return true;
  const wantedCountry=country(target),offeredCountry=country(e);
  if(!wantedCountry||wantedCountry!==offeredCountry)return false;
  const cities=[
    ['bengaluru',['bengaluru','bangalore']],
    ['delhi',['delhi','new delhi','noida','gurugram','gurgaon']],
    ['mumbai',['mumbai','bombay']],
    ['hyderabad',['hyderabad']],
    ['chennai',['chennai','madras']],
    ['pune',['pune']],
    ['kolkata',['kolkata','calcutta']],
    ['toronto',['toronto']],
    ['vancouver',['vancouver']],
    ['new york',['new york']],
    ['san francisco',['san francisco']],
    ['london',['london']],
    ['manchester',['manchester']],
    ['sydney',['sydney']],
    ['melbourne',['melbourne']]
  ];
  const wantedCity=cities.find(([,aliases])=>aliases.some(alias=>targetNorm.includes(alias)));
  if(wantedCity){
    if(wantedCity[1].some(alias=>e.includes(alias)))return true;
    const remote=/\b(remote|telecommute|work from home|distributed team)\b/.test(e);
    return remote&&(locationNorm.includes(wantedCountry)||e.includes('remote '+wantedCountry));
  }
  return true;
}
function quote(value){return'"'+String(value||'').replace(/["\r\n]/g,' ').trim().slice(0,140)+'"';}
function roleVariants(value) {
  const role=String(value||'').trim();
  const variants=[role];
  if(/\bdeveloper\b/i.test(role))variants.push(role.replace(/\bdeveloper\b/gi,'engineer'));
  if(/\bengineer\b/i.test(role))variants.push(role.replace(/\bengineer\b/gi,'developer'));
  if(/\bsoftware developer\b/i.test(role))variants.push(role.replace(/\bsoftware developer\b/i,'software engineer'));
  if(/\bsoftware engineer\b/i.test(role))variants.push(role.replace(/\bsoftware engineer\b/i,'software developer'));
  return [...new Set(variants.map(x=>x.trim()).filter(Boolean))].slice(0,3);
}
function locationVariants(value) {
  const location=String(value||'').trim();
  const variants=[location];
  const normalized=norm(location);
  const aliases=[
    [/\bbengaluru\b|\bbangalore\b/,'Bangalore'],
    [/\bdelhi ncr\b|\bnew delhi\b|\bdelhi\b/,'Noida'],
    [/\bdelhi ncr\b|\bnew delhi\b|\bdelhi\b/,'Gurugram'],
    [/\bmumbai\b/,'Navi Mumbai'],
    [/\bmumbai\b/,'Thane'],
    [/\bgurugram\b|\bgurgaon\b/,'Gurugram'],
    [/\bhyderabad\b/,'Hyderabad'],
    [/\bpune\b/,'Pune'],
    [/\bchennai\b/,'Chennai']
  ];
  for(const [pattern,alias] of aliases)if(pattern.test(normalized)&&!normalized.includes(norm(alias)))variants.push(alias);
  return [...new Set(variants.filter(Boolean))].slice(0,3);
}
function governmentDomains(location) {
  const c=country(location);
  const domains={
    india:['gov.in','nic.in'],
    'united states':['usa.gov','careers.state.gov'],
    canada:['canada.ca','gc.ca'],
    'united kingdom':['gov.uk'],
    australia:['gov.au'],
    germany:['bund.de'],
    singapore:['gov.sg'],
    pakistan:['gov.pk']
  };
  return domains[c]||[];
}
function buildSearchQueries(profile) {
  const role=String(profile.query||profile.jobTitle||'').trim().slice(0,140);
  const loc=String(profile.location||(profile.countries||[]).join(' ')||'').trim().slice(0,100);
  const places=locationVariants(loc);
  const place=places[0]&& !/^(worldwide|global|anywhere|remote|all countries)$/i.test(places[0])?quote(places[0]):'remote';
  const roleForms=roleVariants(role);
  const skills=[...(profile.skills||[]),...(profile.keywords||[])].map(String).map(s=>s.trim()).filter(Boolean).slice(0,5);
  const queries=[];
  const add=(value)=>{const q=String(value||'').replace(/\s+/g,' ').trim();if(q&&!queries.includes(q))queries.push(q);};
  for(const variant of roleForms){
    const exact=quote(variant);
    add(exact+' '+place+' jobs');
    add(variant+' '+place+' jobs OR careers OR openings OR vacancies');
  }
  add(role+' '+place+' hiring recruitment employment opportunities');
  add(role+' '+place+' company career pages');
  add('inurl:careers '+role+' '+place);
  add('inurl:jobs '+role+' '+place);
  add('intitle:recruitment '+role+' '+place+' vacancy OR notification');
  if(skills.length){
    add(role+' '+skills.slice(0,3).join(' ')+' '+place+' jobs');
    add(quote(role)+' '+skills.slice(0,2).map(quote).join(' ')+' '+place+' careers');
  }
  const boardDomains=[
    'linkedin.com/jobs','naukri.com','indeed.com','foundit.in','apna.co','glassdoor.com',
    'wellfound.com/jobs','cutshort.io','instahyre.com','hirist.com','iimjobs.com','shine.com'
  ];
  for(const domain of boardDomains)add('site:'+domain+' '+role+' '+place+' jobs');
  const atsDomains=[
    'boards.greenhouse.io','job-boards.greenhouse.io','jobs.lever.co','jobs.ashbyhq.com',
    'myworkdayjobs.com','jobs.smartrecruiters.com','jobs.workable.com','jobs.jobvite.com',
    'jobs.icims.com','successfactors.eu','oraclecloud.com','teamtailor.com','breezy.hr','recruitee.com'
  ];
  for(const domain of atsDomains)add('site:'+domain+' '+role+' '+place);
  for(const domain of governmentDomains(loc)){
    add('site:'+domain+' '+role+' '+place+' recruitment OR vacancy OR notification');
    add('site:'+domain+' '+role+' recruitment appointment contract');
  }
  add(role+' '+place+' government recruitment vacancy public sector');
  add(role+' '+place+' tender procurement RFP EOI contract opportunity');
  add('('+quote(role)+' OR '+role+') '+place+' internship apprenticeship fellowship recruitment');
  return queries.slice(0,envInt('SERPER_SEARCH_MAX_QUERIES',36,1,64));
}
function safeUrl(raw) {
  try {
    const u=new URL(raw),h=u.hostname.toLowerCase();
    if(!['https:','http:'].includes(u.protocol)||u.username||u.password||!h||h==='localhost'||h.endsWith('.local')||h.endsWith('.internal'))return undefined;
    if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)||h.includes(':')||(u.port&&!['80','443'].includes(u.port)))return undefined;
    u.hash='';return u;
  } catch{return undefined;}
}
function isJobUrl(raw,evidence='') {
  const u=safeUrl(raw);if(!u)return false;
  const h=u.hostname.toLowerCase(),p=(u.pathname+u.search).toLowerCase();
  const blocked=/^\/(?:blog|blogs|news|article|articles|search|about|privacy|terms|events)(?:\/|$)/i.test(u.pathname);
  if(blocked)return false;
  const pathSignal=/(?:^|[\/_-])(?:jobs?|job-listings?|job-openings?|careers?|career-opportunities|positions?|openings?|vacancies|recruitment|recruiting|employment|join-us|work-with-us|internships?|apprenticeships?|fellowships?|notifications?|advertisements?|recruitment-notice|tenders?|procurement|rfp|rfi|eoi|bids?|solicitations?)(?:[\/?._-]|$)/i.test(p);
  const ats=/greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|smartrecruiters\.com|workable\.com|icims\.com|jobvite\.com|successfactors\.|oraclecloud\.com|teamtailor\.com|breezy\.hr|recruitee\.com|pinpoint\.com/i.test(h)&&u.pathname.split('/').filter(Boolean).length>=1;
  const domains=['linkedin.com','naukri.com','indeed.com','foundit.in','apna.co','wellfound.com','glassdoor.com','builtin.com','ziprecruiter.com','cutshort.io','instahyre.com','hirist.com','iimjobs.com','shine.com'];
  const knownBoard=domains.some(d=>h===d||h.endsWith('.'+d))&&u.pathname.split('/').filter(Boolean).length>=1;
  const evidenceSignal=/(job|career|vacanc|recruit|hiring|tender|procurement|\brfp\b|\beoi\b|expression of interest|notification|internship|fellowship|employment opportunity|position available)/i.test(String(evidence||''));
  return pathSignal||ats||knownBoard||(evidenceSignal&&u.pathname.split('/').filter(Boolean).length>=1);
}
function walkPosting(value,out,depth) {
  if(!value||typeof value!=='object'||depth>10)return;
  if(Array.isArray(value)){for(const x of value)walkPosting(x,out,depth+1);return;}
  const type=Array.isArray(value['@type'])?value['@type'].join(' '):String(value['@type']||'');
  if(/\bJobPosting\b/i.test(type))out.push(value);
  for(const child of Object.values(value))if(child&&typeof child==='object')walkPosting(child,out,depth+1);
}
function parsePage(html,url) {
  const p={title:'',description:'',canonicalUrl:url,postings:[]};
  const title=String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const desc=String(html).match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i)||String(html).match(/<meta\b[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  const can=String(html).match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
  p.title=clean(title?.[1]||'');p.description=clean(desc?.[1]||'');
  const c=safeUrl(clean(can?.[1]||''));if(c)p.canonicalUrl=c.href;
  for(const m of String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{walkPosting(JSON.parse(String(m[1]||'').replace(/^\s*<!\[CDATA\[/,'').replace(/\]\]>\s*$/,'')),p.postings,0);}catch{}}
  return p;
}
function companyFrom(url) {
  const h=url.hostname.replace(/^www\./,'').toLowerCase(),parts=url.pathname.split('/').filter(Boolean);
  if(/jobs\.lever\.co|boards\.greenhouse\.io|jobs\.ashbyhq\.com/.test(h)&&parts[0])return parts[0].replace(/[-_]/g,' ');
  return h.split('.').filter(x=>!['jobs','careers','career','apply','boards','www'].includes(x))[0]||h;
}
function opportunityType(title,description,url) {
  const evidence=norm([title,description,url].join(' '));
  if(/\b(tender|procurement|request for proposal|rfp|request for information|rfi|expression of interest|eoi|solicitation|bid submission|public bid)\b/.test(evidence))return 'tender';
  if(/\b(internship|intern|apprenticeship|apprentice|fellowship|trainee)\b/.test(evidence))return 'early-career';
  if(/\b(government|public sector|civil service|public service commission|recruitment notification|employment notification|vacancy notice|official advertisement|department recruitment)\b/.test(evidence))return 'government-recruitment';
  return 'employment';
}
function mapPosting(posting,candidate,page) {
  const loc=[].concat(posting.jobLocation||[]).map(x=>typeof x==='object'?JSON.stringify(x.address||x):String(x)).join(' ');
  const allowed=typeof posting.applicantLocationRequirements==='string'?posting.applicantLocationRequirements:JSON.stringify(posting.applicantLocationRequirements||'');
  const title=clean(posting.title||page.title||candidate.title),description=clean(posting.description||page.description||candidate.description);
  const remote=/telecommute/i.test(String(posting.jobLocationType||'')),u=safeUrl(posting.url||posting.sameAs||page.canonicalUrl||candidate.url);
  return{id:u?u.href:candidate.url,title,company:clean(posting.hiringOrganization?.name||candidate.company||companyFrom(new URL(candidate.url))),location:(loc+' '+allowed).trim()||(remote?'Remote · eligibility not stated':''),country:country(loc+' '+allowed)||'',description,tags:clean(posting.skills||posting.qualifications||''),employmentType:clean(posting.employmentType||''),workMode:remote?'Remote':'',postedAt:clean(posting.datePosted||''),url:u?u.href:candidate.url,source:SOURCE,raw:{sourceDomain:candidate.domain,indexedTitle:candidate.title,indexedSnippet:candidate.description,searchQuery:candidate.query,schemaJobPosting:true,opportunityType:'employment'}};
}
function mapResult(candidate,page) {
  const u=safeUrl(candidate.url);if(!u)return undefined;
  const pageTitle=clean(page?.title||''),description=clean([page?.description,candidate.description,...candidate.extra].filter(Boolean).join(' '));
  const title=pageTitle&&matchesRole(pageTitle,description,candidate.role)?pageTitle:clean(candidate.title||pageTitle);
  const e=title+' '+description+' '+u.href,kind=opportunityType(title,description,u.href);
  const remote=/\b(remote|telecommute|work from home)\b/i.test(e);let loc='';
  if(/\b(worldwide|work from anywhere|remote worldwide|all countries)\b/i.test(e))loc='Worldwide';
  else if(norm(e).includes(norm(candidate.location)))loc=candidate.location;
  else if(country(e))loc=country(e);
  return{id:u.href,title,company:candidate.company||companyFrom(u),location:loc||(remote?'Remote · eligibility not stated':''),country:country(e)||'',description,tags:kind==='employment'?'':kind,employmentType:'',workMode:remote?'Remote':'',postedAt:candidate.age||'',url:u.href,source:SOURCE,raw:{sourceDomain:candidate.domain,indexedTitle:candidate.title,indexedSnippet:candidate.description,searchQuery:candidate.query,schemaJobPosting:false,opportunityType:kind,indexedUrl:u.href}};
}
function candidateFromResult(r,role,location,q) {
  if(!r?.url)return undefined;const u=safeUrl(r.url);
  const title=clean(r.title||''),desc=clean(r.description||r.snippet||''),extra=(r.extra_snippets||[]).map(clean);
  if(!u||!isJobUrl(u.href,[title,desc,...extra].join(' ')))return undefined;
  if(!matchesRole(title,[desc,...extra].join(' '),role))return undefined;
  return{url:u.href,title,description:desc,extra,domain:clean(r.profile?.long_name||r.profile?.name||u.hostname),company:clean(r.profile?.name||''),age:clean(r.page_age||''),query:q,location,role};
}
function normalizeSearchResponse(data) {
  const results = Array.isArray(data?.organic) ? data.organic.map((item) => {
    const rawUrl = String(item?.link || item?.url || '');
    const url = safeUrl(rawUrl);
    const domain = clean(item?.domain || url?.hostname || '');
    return {
      url: url?.href || rawUrl,
      title: clean(item?.title || ''),
      description: clean(item?.snippet || item?.description || ''),
      snippet: clean(item?.snippet || item?.description || ''),
      page_age: clean(item?.date || item?.page_age || ''),
      profile: { name: domain, long_name: domain },
      extra_snippets: []
    };
  }).filter((item) => item.url) : [];
  return { results, more: results.length >= 10 };
}
async function searchPage(q,page,cc) {
  const key=String(process.env.SERPER_API_KEY||'').trim();
  if(!key||key.includes('$'+'{'))throw new Error('Set SERPER_API_KEY in the worker .env to enable Google-style job discovery.');
  const res=await fetch('https://google.serper.dev/search',{
    method:'POST',
    headers:{accept:'application/json','content-type':'application/json','X-API-KEY':key,'User-Agent':'NvoidJobAgent/1.0 (+https://jobkar.in)'},
    body:JSON.stringify({q,gl:String(cc||'IN').toLowerCase(),hl:'en',num:10,page:page+1}),
    signal:AbortSignal.timeout(15000)
  });
  if(!res.ok)throw new Error('Serper Google Search API returned HTTP '+res.status+'. Check SERPER_API_KEY, credits and rate limits.');
  return normalizeSearchResponse(await res.json());
}
async function crawl(rawUrl) {
  let u=safeUrl(rawUrl);if(!u)return undefined;
  for(let i=0;i<4;i++){
    try{
      const res=await fetch(u,{redirect:'manual',headers:{accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5','user-agent':'NvoidJobAgent/1.0 (+https://jobkar.in)'},signal:AbortSignal.timeout(7000)});
      if([301,302,303,307,308].includes(res.status)){const target=res.headers.get('location');if(!target)return undefined;u=safeUrl(new URL(target,u).href);if(!u)return undefined;continue;}
      if(!res.ok||Number(res.headers.get('content-length')||0)>5242880)return undefined;
      const type=String(res.headers.get('content-type')||'').toLowerCase();if(type&&!type.includes('html')&&!type.includes('xhtml'))return undefined;
      const html=await res.text();if(html.length>5242880)return undefined;return parsePage(html,u.href);
    }catch{return undefined;}
  }return undefined;
}
async function concurrent(items,max,fn) {
  let cursor=0;const out=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(max,items.length)},async()=>{while(true){const i=cursor++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch{out[i]=undefined;}}}));
  return out;
}
function searchCountry(loc){const c=country(loc);return({india:'IN','united states':'US',canada:'CA','united kingdom':'GB',australia:'AU',germany:'DE',singapore:'SG',pakistan:'PK'})[c]||'IN';}
async function discover(args,limit) {
  const role=String(args.query||'').trim(),location=String(args.location||(args.countries||[]).join(', ')||'').trim();
  if(!role||!location)throw new Error('Both target job title and preferred location are required.');
  if(!process.env.SERPER_API_KEY||String(process.env.SERPER_API_KEY).includes('$'+'{'))throw new Error('Serper search is disabled. Set SERPER_API_KEY and restart the worker.');
  const target=Math.min(envInt('SERPER_SEARCH_MAX_RESULTS',1000,50,1000),limit),queries=buildSearchQueries({query:role,location,skills:args.skills,keywords:args.keywords}),pageCap=envInt('SERPER_SEARCH_MAX_PAGES_PER_QUERY',10,1,10),requestCap=envInt('SERPER_SEARCH_MAX_REQUESTS',80,1,120);
  const candidateMap=new Map();let calls=0,indexed=0,failures=0,more=false;
  for(let offset=0;offset<pageCap&&calls<requestCap;offset++){
    const tasks=queries.slice(0,Math.min(queries.length,requestCap-calls)).map(q=>({q,offset}));
    const batch=await concurrent(tasks,envInt('SERPER_SEARCH_CONCURRENCY',10,1,10),async task=>({task,page:await searchPage(task.q,task.offset,searchCountry(location))}));
    calls+=tasks.length;
    for(const item of batch){if(!item?.page){failures++;continue;}indexed+=item.page.results.length;more=more||item.page.more;
      for(const r of item.page.results){const c=candidateFromResult(r,role,location,item.task.q);if(c&&!candidateMap.has(c.url))candidateMap.set(c.url,c);}
    }
    if(candidateMap.size>=target*1.2)break;
  }
  const candidates=[...candidateMap.values()],maxFetch=Math.min(envInt('SERPER_SEARCH_MAX_PAGE_FETCHES',250,0,500),candidates.length);
  const crawled=await concurrent(candidates.slice(0,maxFetch),envInt('SERPER_SEARCH_PAGE_CRAWL_CONCURRENCY',20,1,20),async c=>({candidate:c,page:await crawl(c.url)}));
  const unique=new Map();let structured=0,metadata=0;
  for(const item of crawled){if(!item)continue;
    if(item.page?.postings?.length){let accepted=false;
      for(const posting of item.page.postings){const job=mapPosting(posting,item.candidate,item.page);if(!job.url||!isJobUrl(job.url,job.title+' '+job.description)||!matchesRole(job.title,job.description,role)||!locationMatch(job.location,job.description,job.url,location))continue;if(!unique.has(job.url))unique.set(job.url,job);accepted=true;}
      if(accepted){structured++;continue;}
    }
    const job=mapResult(item.candidate,item.page);if(job&&matchesRole(job.title,job.description,role)&&locationMatch(job.location,job.description,job.url,location)){if(!unique.has(job.url))unique.set(job.url,job);metadata++;}
  }
  for(const c of candidates.slice(maxFetch)){const job=mapResult(c,undefined);if(job&&matchesRole(job.title,job.description,role)&&locationMatch(job.location,job.description,job.url,location)){if(!unique.has(job.url))unique.set(job.url,job);metadata++;}}
  const records=[...unique.values()],jobs=records.slice(0,target);
  return{jobs,report:{provider:'Serper Google Search API',mode:'dork-style search-engine discovery and public job-page extraction',queryCount:queries.length,requestsMade:calls,rawIndexedResults:indexed,uniqueRoleLocationUrls:candidates.length,publicJobPagesFetched:crawled.filter(x=>x?.page).length,structuredJobPages:structured,metadataOnlyListings:metadata,matchedJobs:records.length,returnedJobs:jobs.length,targetCount:target,reachedRequestedLimit:jobs.length>=target,moreSearchResultsAvailable:more,failedSearchRequests:failures,truncated:records.length>jobs.length||candidates.length>=target*1.2}};
}
async function search(args) {
  const role=String(args.query||'').trim(),loc=String(args.location||(args.countries||[]).join(', ')||'').trim(),limit=Number.isFinite(Number(args.limit))?Math.min(1000,Math.max(1,Math.floor(Number(args.limit)))):500;
  const key=JSON.stringify({role,loc,skills:args.skills||[],keywords:args.keywords||[],countries:args.countries||[]}),hit=cache.get(key);
  if(hit&&hit.expires>Date.now())return{...hit.value,jobs:hit.value.jobs.slice(0,limit),report:{...hit.value.report,targetCount:limit,returnedJobs:Math.min(limit,hit.value.jobs.length),reachedRequestedLimit:hit.value.jobs.length>=limit}};
  if(pending.has(key)){const value=await pending.get(key);return{...value,jobs:value.jobs.slice(0,limit)};}
  const work=discover(args,Math.min(limit,envInt('SERPER_SEARCH_MAX_RESULTS',1000,50,1000)));pending.set(key,work);
  try{const value=await work;cache.set(key,{value,expires:Date.now()+15*60*1000});if(cache.size>60)cache.delete(cache.keys().next().value);return value;}finally{pending.delete(key);}
}
const tools=[{name:'search_jobs',description:'Search role/location-specific indexed public job pages and careers/ATS boards; extracts schema.org JobPosting data where available.',inputSchema:{type:'object',properties:{query:{type:'string'},location:{type:'string'},countries:{type:'array',items:{type:'string'}},skills:{type:'array',items:{type:'string'}},keywords:{type:'array',items:{type:'string'}},remote:{type:'boolean'},experienceYears:{type:'number'},limit:{type:'integer',minimum:1,maximum:1000}},required:['query','location']}}];
function send(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');}
function sendError(id,code,message){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code,message}})+'\n');}
async function handle(m){
  if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')return;
  const id=m.id;if(id===undefined||id===null||m.method.startsWith('notifications/'))return;
  if(m.method==='initialize'){send(id,{protocolVersion:m.params?.protocolVersion||'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'nvoid-serper-job-crawler',version:'1.0.0'}});return;}
  if(m.method==='ping'){send(id,{});return;}
  if(m.method==='tools/list'){send(id,{tools});return;}
  if(m.method==='tools/call'){if(m.params?.name!=='search_jobs'){sendError(id,-32602,'Unknown tool');return;}
    try{const value=await search(m.params?.arguments||{}),result={jobs:value.jobs,source:'Serper Google Search and Public Job Page Crawler',returnedCount:value.jobs.length,searchMetadata:value.report};send(id,{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result,isError:false});}
    catch(e){sendError(id,-32000,e instanceof Error?e.message:String(e));}return;}
  sendError(id,-32601,'Unsupported method');
}
function start(){const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});rl.on('line',line=>{if(!line.trim())return;try{void handle(JSON.parse(line)).catch(e=>process.stderr.write(String(e)+'\n'));}catch{process.stderr.write('Ignored invalid MCP JSON.\n');}});}
if(require.main===module)start();
module.exports={buildSearchQueries,family,matchesRole,locationMatch,safeUrl,isJobUrl,parsePage,normalizeSearchResponse};
