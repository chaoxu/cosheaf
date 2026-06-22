export interface AsyncJobLimiterConfig {
  readonly concurrency: number;
  readonly queueLimit: number;
  readonly cooldownMs: number;
}

export interface AsyncJobLimiterMetrics {
  readonly active: number;
  readonly queued: number;
  readonly concurrency: number;
  readonly queueLimit: number;
}

export interface AsyncJobLimiterOptions<E extends Error> {
  readonly config: () => AsyncJobLimiterConfig;
  readonly duplicateError: () => E;
  readonly queueFullError: () => E;
  readonly resetError?: () => E;
  readonly now?: () => number;
}

interface PendingJob<E extends Error> {
  readonly resolve: () => void;
  readonly reject: (error: E) => void;
}

export class AsyncJobLimiter<E extends Error = Error> {
  private readonly pending: Array<PendingJob<E>> = [];
  private readonly activeKeys = new Set<string>();
  private readonly cooldowns = new Map<string, number>();
  private active = 0;

  constructor(private readonly options: AsyncJobLimiterOptions<E>) {}

  async run<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    const config = this.options.config();
    const now = this.now();
    this.pruneCooldowns(now);
    if (key) {
      const coolingUntil = this.cooldowns.get(key) ?? 0;
      if (this.activeKeys.has(key) || coolingUntil > now) {
        throw this.options.duplicateError();
      }
      this.activeKeys.add(key);
    }
    try {
      await this.acquire(config);
    } catch (error) {
      if (key) this.activeKeys.delete(key);
      throw error;
    }
    try {
      return await fn();
    } finally {
      if (key) {
        this.activeKeys.delete(key);
        this.cooldowns.set(key, this.now() + config.cooldownMs);
      }
      this.release();
    }
  }

  metrics(): AsyncJobLimiterMetrics {
    const config = this.options.config();
    this.pruneCooldowns(this.now());
    return {
      active: this.active,
      queued: this.pending.length,
      concurrency: config.concurrency,
      queueLimit: config.queueLimit,
    };
  }

  reset(): void {
    const resetError = this.options.resetError ?? this.options.queueFullError;
    for (const job of this.pending.splice(0)) {
      job.reject(resetError());
    }
    this.active = 0;
    this.activeKeys.clear();
    this.cooldowns.clear();
  }

  private acquire(config: AsyncJobLimiterConfig): Promise<void> {
    if (this.active < config.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.pending.length >= config.queueLimit) {
      throw this.options.queueFullError();
    }
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.pending.shift();
    if (next) {
      this.active += 1;
      next.resolve();
    }
  }

  private pruneCooldowns(now: number): void {
    for (const [key, expiresAt] of this.cooldowns) {
      if (expiresAt <= now) this.cooldowns.delete(key);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
