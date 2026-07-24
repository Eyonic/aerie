// A small per-key serializer for operations that combine filesystem and SQLite
// state. Different keys still run concurrently; retries for the same key cannot
// both pass a stat/check step and then mutate the same file.
export class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }

  get activeKeys(): number { return this.tails.size; }
}
