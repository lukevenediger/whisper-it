// One-at-a-time job queue. Transcription is CPU/memory bound and the container
// has a fixed memory budget, so concurrent runs would OOM. Promise-chain based.

export type SerialQueue = {
  /** Enqueue a job; `onStart` fires when it leaves the queue and begins running. */
  enqueue<T>(job: (ctx: { signal: AbortSignal }) => Promise<T>, onStart?: () => void): Promise<T>;
  /** Jobs waiting (not counting the running one). */
  pending(): number;
  running(): boolean;
  /** Resolves once the queue is idle. */
  drain(): Promise<void>;
  /** Abort the running job's signal and every waiting job's signal (shutdown). */
  abortAll(): void;
};

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  let active = false;
  const controllers = new Set<AbortController>();

  return {
    enqueue<T>(
      job: (ctx: { signal: AbortSignal }) => Promise<T>,
      onStart?: () => void,
    ): Promise<T> {
      const ac = new AbortController();
      controllers.add(ac);
      waiting += 1;
      const run = async (): Promise<T> => {
        waiting -= 1;
        active = true;
        try {
          onStart?.();
          return await job({ signal: ac.signal });
        } finally {
          active = false;
          controllers.delete(ac);
        }
      };
      const result = tail.then(run, run);
      tail = result.catch(() => {});
      return result;
    },
    pending: () => waiting,
    running: () => active,
    drain: () => tail.then(() => {}),
    abortAll: () => {
      for (const ac of controllers) ac.abort();
    },
  };
}
