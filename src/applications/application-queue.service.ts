import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Queue, Job } from 'bullmq';
import { createHash } from 'node:crypto';
import type { ApplicationTask, NormalizedJob } from '../common/job.types';
import { APPLICATION_QUEUE } from './application.constants';
import type { EnqueueApplicationsDto } from '../dto/enqueue-applications.dto';

@Injectable()
export class ApplicationQueueService {
  constructor(@InjectQueue(APPLICATION_QUEUE) private readonly queue: Queue<ApplicationTask>) {}

  async enqueue(dto: EnqueueApplicationsDto) {
    const jobs = await Promise.all(dto.jobs.map(async (inputJob) => {
      const job: NormalizedJob = {
        id: inputJob.id,
        source: inputJob.source,
        sourceJobId: inputJob.sourceJobId,
        title: inputJob.title,
        company: inputJob.company,
        location: inputJob.location,
        description: inputJob.description,
        jobUrl: inputJob.jobUrl,
        applicationUrl: inputJob.applicationUrl,
        salaryCurrency: inputJob.salaryCurrency,
        matchScore: typeof inputJob.matchScore === 'number' ? inputJob.matchScore : 0,
        matchReasons: inputJob.matchReasons ?? [],
        raw: inputJob.raw,
      };
      const task: ApplicationTask = {
        userId: dto.userId,
        profile: { ...dto.profile, userId: dto.profile.userId ?? dto.userId },
        job,
        autoSubmit: dto.autoSubmit,
        requestedAt: new Date().toISOString(),
      };
      const destination = normalizeDestination(job.applicationUrl ?? job.jobUrl);
      const identity = destination
        ? `${dto.userId}|url|${destination}`
        : `${dto.userId}|${job.source}|${job.sourceJobId ?? job.id}`;
      const taskId = createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 40);
      const queued = await this.queue.add('apply-job', task, {
        jobId: taskId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
        priority: job.matchScore >= 85 ? 1 : job.matchScore >= 70 ? 5 : 10,
      });
      return { taskId: queued.id, jobId: job.id, title: job.title, company: job.company };
    }));

    return {
      requested: dto.jobs.length,
      queued: jobs.length,
      tasks: jobs,
      note: 'Task IDs are deterministic per user and job identity. Re-enqueueing the same application does not create another BullMQ job while the original record is retained.',
    };
  }

  async getStatus(taskId: string) {
    const job = await this.queue.getJob(taskId);
    if (!job) throw new NotFoundException(`Application task ${taskId} was not found.`);
    return serializeJob(job, await job.getState());
  }

  async getRecent(limit = 50) {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getJobs(['waiting'], 0, safeLimit - 1, true),
      this.queue.getJobs(['active'], 0, safeLimit - 1, true),
      this.queue.getJobs(['completed'], 0, safeLimit - 1, true),
      this.queue.getJobs(['failed'], 0, safeLimit - 1, true),
      this.queue.getJobs(['delayed'], 0, safeLimit - 1, true),
    ]);
    const all: Array<{ job: Job<ApplicationTask>; state: string }> = [
      ...waiting.map((job) => ({ job, state: 'waiting' })),
      ...active.map((job) => ({ job, state: 'active' })),
      ...completed.map((job) => ({ job, state: 'completed' })),
      ...failed.map((job) => ({ job, state: 'failed' })),
      ...delayed.map((job) => ({ job, state: 'delayed' })),
    ];
    return all
      .sort((a, b) => (b.job.timestamp ?? 0) - (a.job.timestamp ?? 0))
      .slice(0, safeLimit)
      .map(({ job, state }) => serializeJob(job, state));
  }
}

function serializeJob(job: Job<ApplicationTask>, state: string) {
  return {
    taskId: job.id,
    state,
    progress: job.progress,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    createdAt: new Date(job.timestamp).toISOString(),
    processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
    userId: job.data.userId,
    job: {
      id: job.data.job.id,
      title: job.data.job.title,
      company: job.data.job.company,
      source: job.data.job.source,
      applicationUrl: job.data.job.applicationUrl,
    },
    result: job.returnvalue,
  };
}

function normalizeDestination(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|trk|ref|source|tracking)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}
