// One operation at a time on the scenes (the controller's single queue):
// user actions, opening a scene and sync steps never interleave. Opening a
// scene goes first (the priority lane): it waits only for the operation
// that is running, not for sync steps that are still waiting.

type Entry = { run: () => void; priority: boolean };

export class OpQueue {
  private readonly waiting: Entry[] = [];
  private running = false;

  /** run `fn` when it is its turn (it runs even if the one before failed) */
  run<T>(fn: () => Promise<T>, { priority = false }: { priority?: boolean } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        priority,
        run: () => {
          let result: Promise<T>;
          try {
            result = fn();
          } catch (error) {
            result = Promise.reject(error);
          }
          result.then(resolve, reject).finally(() => this.next());
        },
      };
      if (priority) {
        // after the other priority entries, before every normal one
        const at = this.waiting.findIndex((other) => !other.priority);
        this.waiting.splice(at === -1 ? this.waiting.length : at, 0, entry);
      } else {
        this.waiting.push(entry);
      }
      if (!this.running) {
        this.next();
      }
    });
  }

  private next() {
    const entry = this.waiting.shift();
    if (entry) {
      this.running = true;
      entry.run();
      return;
    }
    this.running = false;
  }
}
