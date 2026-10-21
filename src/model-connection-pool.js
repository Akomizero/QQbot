import { createModelDispatcher } from "./network-proxy.js";

// Keep healthy tunnels for tool continuations. Retiring a pool drains existing
// responses instead of destroying another request's socket.
export function createModelConnectionPool({ create = createModelDispatcher, now = () => Date.now(), ttlMs = 120_000, maxEntries = 8 } = {}) {
  const entries = new Map(), pending = new Map();
  let sequence = 0, closed = false;
  const retire = entry => { if (entry?.dispatcher) void entry.dispatcher.close().catch(() => {}); };
  const invalidate = entry => {
    if (entries.get(entry?.key) === entry) entries.delete(entry.key);
    retire(entry);
  };
  async function acquire(endpoint, options = {}) {
    if (closed) throw new Error("Model connection pool closed");
    options.signal?.throwIfAborted();
    const key = new URL(endpoint).origin;
    let entry = entries.get(key);
    if (entry && (now() - entry.at >= ttlMs || entry.dispatcher?.closed || entry.dispatcher?.destroyed)) { invalidate(entry); entry = null; }
    if (entry) return { entry, reused: Boolean(entry.dispatcher) };
    let creation = pending.get(key);
    if (!creation) {
      // DNS setup is bounded independently. One cancelled caller must not cancel
      // another caller waiting for the same tunnel pool.
      creation = (async () => {
        const connection = await create(endpoint, { attempt: options.attempt });
        const fresh = { ...connection, key, at: now(), id: ++sequence };
        if (closed) { retire(fresh); throw new Error("Model connection pool closed"); }
        while (entries.size >= maxEntries) invalidate(entries.values().next().value);
        entries.set(key, fresh);
        return fresh;
      })();
      pending.set(key, creation);
      void creation.finally(() => { if (pending.get(key) === creation) pending.delete(key); }).catch(() => {});
    }
    let onAbort;
    try {
      entry = await (options.signal ? Promise.race([creation, new Promise((_, reject) => {
        onAbort = () => reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      })]) : creation);
      options.signal?.throwIfAborted();
      return { entry, reused: false };
    } finally { if (onAbort) options.signal.removeEventListener("abort", onAbort); }
  }
  async function close() {
    closed = true;
    await Promise.allSettled([...pending.values()]);
    const active = [...entries.values()]; entries.clear();
    await Promise.allSettled(active.map(entry => entry.dispatcher?.close()));
  }
  return { acquire, invalidate, close };
}
