export interface BackgroundJobQueue {
  enqueue(jobId: string): Promise<void>;
}

export type DocumentProcessingQueue = BackgroundJobQueue;

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

export class SynchronousDocumentProcessingQueue extends SynchronousBackgroundJobQueue {}
