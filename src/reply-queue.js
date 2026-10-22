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
      return task(state);
    }).finally(() => { state.pending -= 1; });
    state.tail = job.catch(() => {});
    return job;
  }
  function sendBatch(action,parts,sendMessage,allowed=()=>true) {
    if(action!=="send_msg")return sendMessage(action,parts[0]);
    const params=parts[0],key=`${params.message_type}:${params.group_id??params.user_id}`;
    if(parts.some(part=>part.message_type!==params.message_type||String(part.group_id??part.user_id)!==String(params.group_id??params.user_id)))throw new Error("Mixed reply destinations");
    return enqueue(sends,key,async state=>{
      const receipts=[];
      for(let index=0;index<parts.length;index++) {
        if(!allowed())return {cancelled:true,message_ids:receipts.map(item=>item?.message_id).filter(Boolean),partial:receipts.length>0};
        if(index) {
          const delay=intervalMs-(now()-state.lastAt);if(delay>0)await sleep(delay);
          if(!allowed())return {cancelled:true,message_ids:receipts.map(item=>item?.message_id).filter(Boolean),partial:true};
          state.lastAt=now();
        }
        try {
          const sent=await sendMessage(action,parts[index]);
          if(sent?.cancelled)return {...sent,message_ids:receipts.map(item=>item?.message_id).filter(Boolean),partial:receipts.length>0};
          receipts.push(sent);
        } catch(error) {
          if(receipts.length){error.partialDelivery=true;error.sentMessageIds=receipts.map(item=>item?.message_id).filter(Boolean);}
          throw error;
        }
      }
      const last=receipts.at(-1);
      return parts.length===1?last:{...last,message_ids:receipts.map(item=>item?.message_id).filter(Boolean),partCount:receipts.length};
    });
  }
  return {
    run: (key, task) => enqueue(requests, key, task),
    send: (action, params, sendMessage, allowed = () => true) => {
      if (action !== "send_msg") return sendMessage(action, params);
      return sendBatch(action,[params],sendMessage,allowed);
    },
    sendBatch,
  };
}

const coordinator = createReplyCoordinator();
export const queueConversationReply = coordinator.run;
export const paceOneBotMessage = coordinator.send;
export const paceOneBotMessages = coordinator.sendBatch;
