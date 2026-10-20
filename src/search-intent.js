export function parseSearchIntent(content) {
  const text = String(content ?? "").replace(/<@!?[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text) return null;

  const slashCommand = text.match(/^\/(?:搜索|搜网页|search)(?:\s+([\s\S]*))?$/iu);
  if (slashCommand) return { query: (slashCommand[1] ?? "").trim() };

  const naturalRequest = text.match(
    /^(?:请|麻烦)?(?:你)?(?:能否|能不能|可以|能)?(?:帮我|帮忙|给我)?\s*(?:在网上|网上|联网|上网)?(?:搜索一下|搜索|搜网页|网上搜|搜一下|搜|上网查|联网查|查一下|查下|查查)\s*(?:一下)?\s*[:：,，]?\s*([\s\S]*)$/iu,
  );
  if (!naturalRequest) return null;
  return { query: naturalRequest[1].trim() };
}
