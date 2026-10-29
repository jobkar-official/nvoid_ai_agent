import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const RELEASE_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

@Injectable()
export class DomainLockService implements OnModuleDestroy {
  private readonly logger = new Logger(DomainLockService.name);
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(private readonly configService: ConfigService) {
    const tls = this.configService.get<boolean>('redis.tls', false);
    this.prefix = this.configService.get<string>('queuePrefix', 'job-agent');
    this.redis = new Redis({
      host: this.configService.get<string>('redis.host', '127.0.0.1'),
      port: this.configService.get<number>('redis.port', 6379),
      username: this.configService.get<string | undefined>('redis.username'),
      password: this.configService.get<string | undefined>('redis.password'),
      ...(tls ? { tls: {} } : {}),
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async runWithUrlLock<T>(urlValue: string, work: () => Promise<T>): Promise<T> {
    let url: URL;
    try { url = new URL(urlValue); } catch { return work(); }
    if (!['http:', 'https:'].includes(url.protocol)) return work();
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host) return work();
    const key = `${this.prefix}:domain-lock:${host}`;
    const token = randomUUID();
    const ttlMs = this.configService.get<number>('domainLockTtlMs', 180000);
    const maxWaitMs = this.configService.get<number>('domainLockMaxWaitMs', 90000);
    const start = Date.now();

    await this.ensureConnected();
    while (Date.now() - start < maxWaitMs) {
      const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
      if (acquired === 'OK') {
        this.logger.debug(`Acquired application lock for ${host}.`);
        const heartbeat = setInterval(() => {
          void this.redis.eval(RENEW_LOCK_SCRIPT, 1, key, token, ttlMs).catch((error) => {
            this.logger.warn(`Could not renew domain lock for ${host}: ${this.errorMessage(error)}`);
          });
        }, Math.max(5000, Math.floor(ttlMs / 3)));
        heartbeat.unref?.();
        try {
          return await work();
        } finally {
          clearInterval(heartbeat);
          await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token).catch((error) => {
            this.logger.warn(`Could not release domain lock for ${host}: ${this.errorMessage(error)}`);
          });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 350 + Math.floor(Math.random() * 250)));
    }
    throw new Error(`Another worker is processing ${host}; domain lock was not acquired within ${maxWaitMs}ms.`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
