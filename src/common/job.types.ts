export interface JobProfile {
  userId?: string;
  jobTitle: string;
  location?: string;
  countries?: string[];
  remote?: boolean;
  skills?: string[];
  keywords?: string[];
  experienceYears?: number;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  employmentTypes?: string[];
  workAuthorization?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  currentCompany?: string;
  currentTitle?: string;
  summary?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
  resumePath?: string;
  resumeUrl?: string;
}

export interface NormalizedJob {
  id: string;
  source: string;
  sourceJobId?: string;
  title: string;
  company?: string;
  location?: string;
  country?: string;
  description?: string;
  salary?: string;
  jobUrl?: string;
  applicationUrl?: string;
  employmentType?: string;
  workMode?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  postedAt?: string;
  experience?: string;
  matchScore: number;
  matchReasons: string[];
  raw?: Record<string, unknown>;
}

export type ApplicationStatus =
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'APPLIED'
  | 'FAILED'
  | 'RETRY_PENDING'
  | 'NEEDS_USER_ACTION'
  | 'SKIPPED';

export interface ApplicationTask {
  userId: string;
  profile: JobProfile;
  job: NormalizedJob;
  autoSubmit?: boolean;
  requestedAt: string;
}

export interface ApplicationResult {
  status: ApplicationStatus;
  userId: string;
  jobId: string;
  source: string;
  jobTitle: string;
  company?: string;
  applicationUrl?: string;
  message: string;
  externalApplicationId?: string;
  screenshotPath?: string;
  completedAt: string;
}
