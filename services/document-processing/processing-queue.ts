export interface BackgroundJobQueue {
  enqueue(jobId: string): Promise<void>;
}

export type DocumentProcessingQueue = BackgroundJobQueue;

export type BackgroundJobMode = 'durable' | 'synchronous';

export function getBackgroundJobMode(value = process.env.BACKGROUND_JOB_MODE): BackgroundJobMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'synchronous') return 'synchronous';
  if (normalized === 'durable') return 'durable';
  throw new Error('BACKGROUND_JOB_MODE must be either synchronous or durable.');
}

/**
 * Development adapter for the durable processing queue. Production can replace
 * this with a broker-backed adapter without changing job creation or workers.
 */
export class SynchronousBackgroundJobQueue implements BackgroundJobQueue {
  readonly #handler: (jobId: string) => Promise<void>;

  constructor(handler: (jobId: string) => Promise<void>) {
    this.#handler = handler;
  }

  async enqueue(jobId: string): Promise<void> {
    await this.#handler(jobId);
  }
}

/**
 * Durable jobs are committed with the domain mutation. Enqueue is therefore a
 * wake-up boundary rather than a second persistence write; PostgreSQL workers
 * discover the committed row through atomic claims.
 */
export class PostgresBackgroundJobQueue implements BackgroundJobQueue {
  async enqueue(): Promise<void> {}
}

export class SynchronousDocumentProcessingQueue extends SynchronousBackgroundJobQueue {}
