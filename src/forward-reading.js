// In-memory observations only. Raw images are released between batches.
export async function prepareForwardReading(record, { describe, withImages, progress, allowed, userQuestion = "" }) {
  const deadline = Date.now() + 30 * 60_000;
  const running = () => allowed() && Date.now() < deadline;
  const safe = value => {
    let text = String(value ?? "");
    for (const name of ["QQBOT_LLM_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY", "ONEBOT_ACCESS_TOKEN", "QQBOT_MODEL_PROXY_URL"]) {
      const key = process.env[name]; if (key?.length >= 8) text = text.replaceAll(key, "[凭据已隐藏]");
    }
    return text;
  };
  let lastProgress = Date.now(), imageAttempts = 0;
  const originals = record.nodes;
  record.batchPrepared = true;
  record.visualReadings = [];
  record.failedImageNumbers = [];
  record.textBatches = [];
  const longText = JSON.stringify(originals).length > 18000;
  await progress(`这条转发有${record.nodes.length}条记录、${record.imageCount}张图。我会${record.images.length ? "每次看2张图，" : ""}${longText ? "分段读文字，" : ""}读完再一起回复，可能需要几分钟。`).catch(() => {});
  async function report() {
    if (Date.now() - lastProgress < 60000 || !allowed()) return;
    lastProgress = Date.now();
    await progress(`还在读这条转发：已处理${record.textBatches.length}段文字，已尝试看${imageAttempts}/${record.images.length}张图，暂时未能读取的会在最后说明。`).catch(() => {});
  }
  if (longText) {
    const chunks = []; let chunk = [], length = 0;
    for (let index = 0; index < originals.length; index++) {
      const node = originals[index];
      // Oversized single nodes are split without discarding their middle.
      const body = node.content || "";
      for (let offset = 0; offset < Math.max(1, body.length); offset += 8000) {
        const part = { ...node, originalNode: index + 1, content: body.slice(offset, offset + 8000) };
        const size = JSON.stringify(part).length;
        if (length + size > 10000 && chunk.length) { chunks.push(chunk); chunk = []; length = 0; }
        chunk.push(part); length += size;
      }
    }
    if (chunk.length) chunks.push(chunk);
    for (const nodes of chunks) {
      if (!running()) break;
      const range = [nodes[0].originalNode, nodes.at(-1).originalNode];
      try { const result = await describe({ nodes, userQuestion, allowed: running }); record.textBatches.push({ range, summary: safe(result.summary), read: true }); }
      catch { record.textBatches.push({ range, summary: "本段阅读失败，不能据此推断内容", read: false }); }
      await report();
    }
    record.nodes = record.textBatches.map(part => ({ speaker: "分段阅读记录", content: `原节点${part.range.join("至")}：${part.summary}` }));
    if (record.textBatches.length < chunks.length) record.notes.push("文字分段阅读因停止或总时限结束，没有处理全部段落");
    if (record.textBatches.some(part => !part.read)) record.notes.push("有文字段落阅读失败，最终回复只依据成功读取的段落");
    record.textReadingComplete = record.textBatches.length === chunks.length && record.textBatches.every(part => part.read);
  } else record.textReadingComplete = true;
  async function readImages(refs) {
    if (!running()) return;
    let loaded = false;
    try {
      await withImages(refs, async prepared => {
        loaded = true;
        if (!running()) return;
        const images = prepared.map((image, i) => ({ number: refs[i].forwardedNumber, dataUrl: image.dataUrl }));
        const relevant = originals.filter(node => refs.some(ref => node.content.includes(`转发图片${ref.forwardedNumber}，`))).map(node => ({ ...node, content: node.content.slice(0, 3000) })).slice(0, 4);
        const result = await describe({ images, nodes: relevant, userQuestion, allowed: running });
        record.visualReadings.push(...result.images.map(item => ({ number: item.number, summary: safe(item.summary) })));
      });
    } catch {
      // Retry loading individually when a bad file or a pair size limit hid its neighbour.
      if (!loaded && refs.length > 1) { for (const ref of refs) await readImages([ref]); return; }
    }
    imageAttempts += refs.length;
    for (const ref of refs) if (!record.visualReadings.some(item => item.number === ref.forwardedNumber)) record.failedImageNumbers.push(ref.forwardedNumber);
  }
  for (let index = 0; index < record.images.length && running(); index += 2) {
    await readImages(record.images.slice(index, index + 2));
    await report();
  }
  const readNumbers = new Set(record.visualReadings.map(item => item.number));
  record.failedImageNumbers = [...new Set(record.images.filter(ref => !readNumbers.has(ref.forwardedNumber)).map(ref => ref.forwardedNumber))];
  record.imagesRead = readNumbers.size;
  if (record.failedImageNumbers.length) record.notes.push(`转发图片${record.failedImageNumbers.join("、")}未能读取，不能推断这些图片的内容`);
  const targetCount = record.requestedImageNumbers?.length || record.imageCount;
  record.readingComplete = record.textReadingComplete && !record.truncated && record.imagesRead === targetCount;
  // Image bytes and fetched references are not retained as long-term memory.
  record.images = [];
  return record;
}
