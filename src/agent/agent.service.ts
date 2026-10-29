import { Injectable } from '@nestjs/common';
import type { ApplicationJobDto, EnqueueApplicationsDto } from '../dto/enqueue-applications.dto';
import type { RunAgentDto } from '../dto/run-agent.dto';
import { ApplicationQueueService } from '../applications/application-queue.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { JobDiscoveryService } from '../jobs/job-discovery.service';

@Injectable()
export class AgentService {
  constructor(
    private readonly discovery: JobDiscoveryService,
    private readonly applications: ApplicationQueueService,
    private readonly mcpRegistry: McpRegistryService,
  ) {}

  async run(dto: RunAgentDto) {
    const profile = { ...dto.profile, userId: dto.profile.userId ?? dto.userId };
    const search = await this.discovery.search(profile, dto.searchLimit, dto.serverIds, dto.syncToBackend !== false);
    const applications = search.jobs
      .filter((job) => job.matchScore >= dto.minMatchScore!)
      .filter((job) => job.source !== 'jobicy')
      .filter((job) => Boolean(job.applicationUrl || job.jobUrl || this.mcpRegistry.getJobApplicationConfig(job.source)))
      .slice(0, dto.applyLimit)
      .map((job): ApplicationJobDto => ({
        id: job.id,
        source: job.source,
        sourceJobId: job.sourceJobId,
        title: job.title,
        company: job.company,
        location: job.location,
        description: job.description,
        jobUrl: job.jobUrl,
        applicationUrl: job.applicationUrl,
        salaryCurrency: job.salaryCurrency,
        matchScore: job.matchScore,
        matchReasons: job.matchReasons,
        raw: job.raw,
      }));

    let queueResult: unknown;
    if (applications.length > 0) {
      const enqueueDto: EnqueueApplicationsDto = {
        userId: dto.userId,
        profile,
        jobs: applications,
        autoSubmit: dto.autoSubmit,
      };
      queueResult = await this.applications.enqueue(enqueueDto);
    } else {
      const listingOnlyJobs = search.jobs.filter((job) => job.source === 'jobicy').length;
      queueResult = {
        requested: 0,
        queued: 0,
        tasks: [],
        note: listingOnlyJobs > 0
          ? 'Jobicy public results link to listing pages, not verified employer application forms. Open a listing and continue on the employer site; these results were not queued as applications.'
          : 'No jobs met the score and application-source requirements.',
      };
    }

    return {
      userId: dto.userId,
      completedAt: new Date().toISOString(),
      search: {
        requestedLimit: search.requestedLimit,
        returnedCount: search.returnedCount,
        sources: search.sources,
        backendSync: search.backendSync,
        jobs: search.jobs,
      },
      applicationQueue: queueResult,
      autoSubmitRequested: dto.autoSubmit,
      message: dto.autoSubmit
        ? 'Matching jobs were queued. Submission still requires AUTO_SUBMIT_ENABLED=true and, for browser execution, an allowed destination domain. Review task states for unconfirmed submissions.'
        : 'Matching jobs were queued in review mode. Enable auto-submit only after configuring authorized connectors and destination allowlists.',
    };
  }
}
