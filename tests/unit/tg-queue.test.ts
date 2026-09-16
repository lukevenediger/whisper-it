import { describe, it, expect } from "vitest";
import { createSerialQueue } from "../../src/telegram/queue";

const defer = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("serial queue", () => {
  it("runs jobs strictly one after another in order", async () => {
    const q = createSerialQueue();
    const order: string[] = [];
    const gate = defer<void>();
    const a = q.enqueue(async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
      return "A";
    });
    const b = q.enqueue(async () => {
      order.push("b:start");
      return "B";
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["a:start"]);
    expect(q.pending()).toBe(1);
    expect(q.running()).toBe(true);
    gate.resolve();
    expect(await a).toBe("A");
    expect(await b).toBe("B");
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    expect(q.pending()).toBe(0);
    expect(q.running()).toBe(false);
  });

  it("calls onStart when a job leaves the queue and keeps going after a rejection", async () => {
    const q = createSerialQueue();
    let started = 0;
    const failing = q.enqueue(async () => {
      throw new Error("boom");
    });
    const ok = q.enqueue(
      async () => "fine",
      () => started++,
    );
    await expect(failing).rejects.toThrow("boom");
    expect(await ok).toBe("fine");
    expect(started).toBe(1);
  });

  it("drain() resolves once idle and abortAll() aborts the running job's signal", async () => {
    const q = createSerialQueue();
    let aborted = false;
    const gate = defer<void>();
    const job = q.enqueue(async ({ signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        gate.resolve();
      });
      await gate.promise;
      return "done";
    });
    await new Promise((r) => setTimeout(r, 5));
    q.abortAll();
    expect(await job).toBe("done");
    expect(aborted).toBe(true);
    await q.drain();
    expect(q.running()).toBe(false);
  });
});
