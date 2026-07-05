export class KeyedQueue {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => gate);
    this.queues.set(key, next);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }
}
