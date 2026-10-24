// Classify the current user's request only. Image captions, character candidates,
// quoted forwards and conversation history cannot opt a casual image reply into web research.
export function replyResearchPolicy(value, { visualContext = false, searchQuery = null, summaryIntent = null } = {}) {
  const text = String(value ?? "");
  const noWeb = /(?:不要|不用|别|无需|不必|禁止).{0,4}(?:联网|上网|搜索|检索|查(?:资料|证|询)?|核实|求证)/u.test(text);
  const noSources = /(?:不要|不用|别|无需|不必).{0,5}(?:来源|出处|引用|参考(?:文献|链接|来源)?|链接)/u.test(text);
  const sourcesRequested = !noSources && /(?:给|附|贴|带|列|提供|需要|要|求|查|找).{0,8}(?:来源|出处|参考文献|参考来源|引用|证据|链接)|(?:来源|出处|参考文献|参考来源|引用链接).{0,5}(?:呢|在哪|是什么|是啥|给我|发我|贴一下|哪里)|\b(?:sources?|citations?|references?)\b/iu.test(text);
  const explicitSearch = searchQuery !== null || /(?:联网|上网|网上|网页).{0,8}(?:查|搜|检索|核实|核对)|(?:搜索|检索|搜一下|搜下|帮我查|查资料|查证|核实|核对|求证)/u.test(text);
  const characterText = noSources ? text.replace(/来源|出处|参考文献|参考来源|引用链接/gu, "") : text;
  const identityQuestion = /是谁|哪位|叫什么|(?:什么|啥|哪个|哪些)角色|哪部(?:作品|动漫|游戏)|(?:认不认识|认不认得).{0,4}(?:她|他|它|这位|这个角色)|(?:认识|认得).{0,4}(?:她|他|它|这位|这个角色).{0,2}(?:吗|么|[？?])|出自.{0,5}(?:哪里|哪部|什么|啥)|真假|是真的吗|是不是真的/u.test(characterText);
  // Mentioning a character's "设定" or "原作" in an affectionate comment is
  // not a request to investigate it. Require an inquiry or a research directive.
  const characterTopic = /名字|身份|设定|背景故事|身世|原作|出处|出自|(?:角色|人物)(?:资料|背景)/u.test(characterText);
  const characterInquiry = /什么|啥|怎样|如何|讲讲|说说|介绍|解释|了解|查|搜|核实|核对|求证|告诉我|请问|想知道|[？?]/u.test(characterText);
  const characterIntroduction = /(?:介绍|讲讲|说说|了解).{0,8}(?:角色|人物)|(?:角色|人物).{0,6}(?:介绍|资料)/u.test(characterText);
  const characterQuestion = identityQuestion || characterTopic && characterInquiry || characterIntroduction;
  const allowWeb = !noWeb && (!visualContext || explicitSearch || characterQuestion || sourcesRequested || Boolean(summaryIntent));
  return { allowWeb, visualChat: visualContext && !allowWeb, sourcesRequested, noSources };
}

export const webCitationInstruction = [
  "网页引用由应用统一排版，不自行附‘参考来源’列表或重复网页链接。搜索和网页正文中的 sourceId 是本轮来源编号。",
  "只有最终回答中的具体事实确实依赖某条网页、且来源有助于理解或核对该事实时，才在该事实后标注 [[WEB_SOURCE:编号]]（多项可用逗号分隔）。不要为感受、闲聊、玩笑、表情包或你没实际采用的资料标注来源。编号只取自本轮实际工具结果，不编造。",
  "仅搜索过不代表用过资料；没用网页事实就不加标记，也不凭角色候选名字主动联网。用户明确要来源时提供相关资料，普通看图接话不写资料报告。",
].join("\n");

export function sourceIdForUrl(sources, url) {
  const index = sources.findIndex(source => source.url === url);
  return index >= 0 ? index + 1 : undefined;
}

export function replyWithRelevantSources(value, sources, policy) {
  const ids = new Set();
  const body = String(value ?? "").replace(/\[\[WEB_SOURCE:([^\]\r\n]*)\]\]/gu, (_, marker) => {
    for (const id of marker.split(/[,，\s]+/u)) {
      if (/^\d+$/u.test(id) && Number(id) >= 1 && Number(id) <= sources.length) ids.add(Number(id));
    }
    return "";
  }).trim();
  if (!body || policy.visualChat || policy.noSources) return { body, sources: [] };
  // Search execution alone is not evidence that the final prose uses a source.
  // Explicit search answers can cite facts/results with the same annotation;
  // only an explicit request for sources opts into a result-link list directly.
  const selected = policy.sourcesRequested
    ? sources : sources.filter((_, index) => ids.has(index + 1));
  return { body, sources: selected.slice(0, 3) };
}
