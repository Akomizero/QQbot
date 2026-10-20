export function createReplyCoordinator({ intervalMs = 10_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const requests = new Map();
  const sends = new Map();
  function enqueue(map, key, task) {
    let state = map.get(key);
    if (!state) {
      if (map.size >= 1024) for (const [oldKey, old] of map) if (!old.pending && now() - old.lastAt > intervalMs) map.delete(oldKey);
      if (map.size >= 1024) return Promise.resolve({ cancelled: true });
      state = { tail: Promise.resolve(), pending: 0, lastAt: -Infinity };
      map.set(key, state);
    }
    if (state.pending >= 50) return Promise.resolve({ cancelled: true });
    state.pending += 1;
    const job = state.tail.catch(() => {}).then(async () => {
      const delay = intervalMs - (now() - state.lastAt);
      if (delay > 0) await sleep(delay);
      state.lastAt = now();
      return task();
    }).finally(() => { state.pending -= 1; });
    state.tail = job.catch(() => {});
    return job;
  }
  return {
    run: (key, task) => enqueue(requests, key, task),
    send: (action, params, sendMessage, allowed = () => true) => {
      if (action !== "send_msg") return sendMessage(action, params);
      const key = `${params.message_type}:${params.group_id ?? params.user_id}`;
      return enqueue(sends, key, () => allowed() ? sendMessage(action, params) : { cancelled: true });
    },
  };
}

const coordinator = createReplyCoordinator();
export const queueConversationReply = coordinator.run;
export const paceOneBotMessage = coordinator.send;
