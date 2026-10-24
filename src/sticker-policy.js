export const stickerGroupLimit = 20;
export function stickerLearningCapacity(entries, groupId) {
  if (entries.length >= 50) return { allowed: false, reason: "library-count" };
  if (entries.filter(e => ['group','private'].includes(e.origin)).length >= 40) return { allowed: false, reason: "learned-count" };
  if (entries.filter(e => e.groupId === groupId).length >= stickerGroupLimit) return { allowed: false, reason: "group-count" };
  if (entries.reduce((sum, e) => sum + e.size, 0) >= 60 * 1024 * 1024) return { allowed: false, reason: "library-bytes" };
  return { allowed: true, reason: "available" };
}
export const stickerContentKey = entry => entry.reviewHash || entry.sourceHash || entry.id;
export function recentStickerAllows(sticker, recent, { now = Date.now(), equivalentIds = [] } = {}) {
  const same = item => item.id === sticker.id || equivalentIds.includes(item.id) || item.contentHash && item.contentHash === stickerContentKey(sticker);
  // With no other context-appropriate candidate, prefer text to the same image.
  if (recent.at(-1) && same(recent.at(-1))) return false;
  return !recent.slice(-3).some(item => now - item.at < 10 * 60_000 && same(item));
}
