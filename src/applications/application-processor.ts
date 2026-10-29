import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { ApplicationResult, ApplicationTask } from '../common/job.types';
import { BackendSyncService } from '../common/backend-sync.service';
import { APPLICATION_QUEUE, APPLICATION_WORKER_CONCURRENCY } from './application.constants';
import { ApplicationExecutorService } from './application-executor.service';
import { DomainLockService } from './domain-lock.service';

@Processor(APPLICATION_QUEUE, { concurrency: APPLICATION_WORKER_CONCURRENCY })
export class ApplicationProcessor extends WorkerHost {
  private readonly logger = new Logger(ApplicationProcessor.name);

  constructor(
    private readonly executor: ApplicationExecutorService,
    private readonly backendSync: BackendSyncService,
    private readonly domainLock: DomainLockService,
  ) {
    super();
  }

  async process(job: Job<ApplicationTask>): Promise<unknown> {
    await job.updateProgress(5);
    const targetUrl = job.data.job.applicationUrl ?? job.data.job.jobUrl;
    let result: ApplicationResult;

    try {
      result = targetUrl
        ? await this.domainLock.runWithUrlLock(targetUrl, () => this.executor.execute(job.data))
        : await this.executor.execute(job.data);
    } catch (error) {
      result = {
        userId: job.data.userId,
        jobId: job.data.job.id,
        source: job.data.job.source,
        jobTitle: job.data.job.title,
        company: job.data.job.company,
        applicationUrl: targetUrl,
        status: 'RETRY_PENDING',
        message: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
    }

    result = { ...result, completedAt: new Date().toISOString() };
    await job.updateProgress(90);
    try {
      await this.backendSync.syncApplication(result);
    } catch (error) {
      this.logger.error(`Application ${result.jobId} was processed but backend status sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await job.updateProgress(100);
    return result;
  }
}
