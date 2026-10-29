import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplicationResult, JobProfile, NormalizedJob } from './job.types';

@Injectable()
export class BackendSyncService {
  private readonly logger = new Logger(BackendSyncService.name);

  constructor(private readonly configService: ConfigService) {}

  async syncJobs(userId: string | undefined, profile: JobProfile, jobs: NormalizedJob[]): Promise<{ synced: boolean; reason?: string }> {
    const baseUrl = this.configService.get<string>('backend.baseUrl', '').trim();
    if (!baseUrl) return { synced: false, reason: 'BACKEND_API_BASE_URL is not configured.' };
    const path = this.configService.get<string>('backend.jobImportPath', '/internal/agent/jobs/import');
    try {
      await this.post(baseUrl, path, {
        userId: userId ?? profile.userId,
        profile,
        jobs,
        discoveredAt: new Date().toISOString(),
      });
      return { synced: true };
    } catch (error) {
      const message = this.message(error);
      this.logger.error(`Job sync to backend failed: ${message}`);
      return { synced: false, reason: message };
    }
  }

  async syncApplication(result: ApplicationResult): Promise<void> {
    const baseUrl = this.configService.get<string>('backend.baseUrl', '').trim();
    if (!baseUrl) return;
    const path = this.configService.get<string>('backend.applicationEventPath', '/internal/agent/applications/events');
    try {
      await this.post(baseUrl, path, result);
    } catch (error) {
      this.logger.error(`Application status sync failed for job ${result.jobId}: ${this.message(error)}`);
      throw error;
    }
  }

  private async post(baseUrl: string, path: string, body: unknown): Promise<void> {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
    const url = new URL(normalizedPath, normalizedBase);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Backend API URL must use HTTP or HTTPS.');

    const token = this.configService.get<string>('backend.token', '');
    const timeoutMs = this.configService.get<number>('backend.requestTimeoutMs', 15000);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 800);
      throw new Error(`Backend returned HTTP ${response.status}: ${text}`);
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
