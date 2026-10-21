const commandList = document.querySelector("#command-list");
const commandCount = document.querySelector("#command-count");
const emptyState = document.querySelector("#empty-state");
const form = document.querySelector("#command-form");
const editorTitle = document.querySelector("#editor-title");
const editorSubtitle = document.querySelector("#editor-subtitle");
const formError = document.querySelector("#form-error");
const toast = document.querySelector("#toast");
const llmSettingsForm = document.querySelector("#llm-settings-form");
const llmSettingsError = document.querySelector("#llm-settings-error");
const accessControlForm = document.querySelector("#access-control-form");
const accessControlError = document.querySelector("#access-control-error");
const apiKeyStatus = document.querySelector("#api-key-status");
const tavilyKeyStatus = document.querySelector("#tavily-key-status");
const serperKeyInput = document.querySelector("#serper-api-key");
const clearSerperKey = document.querySelector("#clear-serper-api-key");
function setSearchKeyStatus(data) {
  const serper = data.settings.searchProvider === "serper";
  const configured = serper ? data.serperApiKeyConfigured : data.searchApiKeyConfigured;
  tavilyKeyStatus.textContent = serper ? `Serper ${configured ? "已配置 · Google 统一检索" : "未配置密钥"}` : `Tavily ${configured ? "已配置" : "未配置"} · Exa / B站备用`;
  tavilyKeyStatus.classList.toggle("key-configured", Boolean(configured));
  tavilyKeyStatus.classList.toggle("key-missing", !configured);
}
const onebotStatus = document.querySelector("#onebot-status");
const llmApiKeyInput = document.querySelector("#llm-api-key");
const clearLlmApiKey = document.querySelector("#clear-llm-api-key");
const refreshModelsButton = document.querySelector("#refresh-models");
const modelListStatus = document.querySelector("#model-list-status");
const localConfigCheck = document.querySelector("#local-config-check");
const checkLocalConfigButton = document.querySelector("#check-local-config");
const authPanel = document.querySelector("#auth-panel");
const managementContent = document.querySelector("#management-content");
const setupForm = document.querySelector("#setup-form");
const loginForm = document.querySelector("#login-form");
const setupPassword = document.querySelector("#setup-password");
const setupPasswordConfirm = document.querySelector("#setup-password-confirm");
const loginPassword = document.querySelector("#login-password");
const setupError = document.querySelector("#auth-error");
const loginError = document.querySelector("#login-error");
const adminLogout = document.querySelector("#admin-logout");
const llmFields = {
  apiEndpoint: document.querySelector("#llm-api-endpoint"),
  model: document.querySelector("#llm-model"),
  systemPrompt: document.querySelector("#llm-system-prompt"),
  personality: document.querySelector("#llm-personality"),
  expressionStyle: document.querySelector("#llm-expression-style"),
  memory: document.querySelector("#llm-memory"),
  knowledgeEnabled: document.querySelector("#knowledge-enabled"),
  knowledgeLearningEnabled: document.querySelector("#knowledge-learning-enabled"),
  memberImpressionsEnabled: document.querySelector("#member-impressions-enabled"),
  memberImpressionsLearningEnabled: document.querySelector("#member-impressions-learning-enabled"),
  stickersEnabled: document.querySelector("#stickers-enabled"),
  stickerLearningEnabled: document.querySelector("#sticker-learning-enabled"),
  nicknameTriggerEnabled: document.querySelector("#nickname-trigger-enabled"),
  conversationFollowupEnabled: document.querySelector("#conversation-followup-enabled"),
  forwardReadingEnabled: document.querySelector("#forward-reading-enabled"),
  botAliases: document.querySelector("#bot-aliases"),
  proactivePauseWhenIgnored: document.querySelector("#proactive-pause-when-ignored"),
  temperature: document.querySelector("#llm-temperature"),
  maxTokens: document.querySelector("#llm-max-tokens"),
  modelRetryEnabled: document.querySelector("#model-retry-enabled"),
  longReplyForwardEnabled: document.querySelector("#long-reply-forward-enabled"),
  longReplyThreshold: document.querySelector("#long-reply-threshold"),
  detailedDiscussionEnabled: document.querySelector("#detailed-discussion-enabled"),
  contentSummaryEnabled: document.querySelector("#content-summary-enabled"),
  summaryOutput: document.querySelector("#summary-output"),
  searchProvider: document.querySelector("#search-provider"),
  searchCountry: document.querySelector("#search-country"),
  searchLanguage: document.querySelector("#search-language"),
  searchEnabled: document.querySelector("#search-enabled"),
  visionEnabled: document.querySelector("#vision-enabled"),
  chatgptImageGenerationEnabled: document.querySelector("#chatgpt-image-generation-enabled"),
  characterRecognitionEnabled: document.querySelector("#character-recognition-enabled"),
  visualMemoryLearningEnabled: document.querySelector("#visual-memory-learning-enabled"),
  videoUnderstandingEnabled: document.querySelector("#video-understanding-enabled"),
  videoDiscoveryEnabled: document.querySelector("#video-discovery-enabled"),
  videoDiscoveryGroupIds: document.querySelector("#video-discovery-group-ids"),
  videoAsrEnabled: document.querySelector("#video-asr-enabled"),
  videoFramesEnabled: document.querySelector("#video-frames-enabled"),
  videoMaxMinutes: document.querySelector("#video-max-minutes"),
  proactiveChatEnabled: document.querySelector("#proactive-chat-enabled"),
  proactiveCooldownMinutes: document.querySelector("#proactive-cooldown-minutes"),
  proactiveFrequencyMinutes: document.querySelector("#proactive-frequency-minutes"),
  proactiveDebounceSeconds: document.querySelector("#proactive-debounce-seconds"),
  proactiveDailyLimit: document.querySelector("#proactive-daily-limit"),
};

const accessControlFields = {
  groupIds: document.querySelector("#allowed-group-ids"),
  userIds: document.querySelector("#allowed-user-ids"),
};

const fields = {
  id: document.querySelector("#command-id"),
  name: document.querySelector("#command-name"),
  aliases: document.querySelector("#command-aliases"),
  type: document.querySelector("#command-type"),
  reply: document.querySelector("#command-reply"),
};

const typeNames = {
  text: "固定文本",
  time: "当前时间",
  dice: "随机骰子",
  echo: "重复输入",
};

const typeHints = {
  text: "可在回复内容里使用 {{input}} 插入用户输入。",
  time: "建议在回复内容里使用 {{time}} 插入当前上海时间。",
  dice: "建议在回复内容里使用 {{dice}} 插入 1 到 6 的随机点数。",
  echo: "使用 {{input}} 插入用户输入；重复内容最多 300 个字符。",
};

const stylePresets = {
  "网友聊天": "语气像熟悉的网友聊天：自然、简洁、回应上下文，适度幽默；避免说教、过度热情或暗示现实中的私人关系。",
  "角色扮演": "仅在用户明确提出角色扮演或指定虚构角色时进入角色；按用户给出的设定表达，不主动虚构现实身份、关系或经历。用户未提出时，保持当前人设和语气。",
};

let commands = [];
let selectedId = null;
let toastTimer;
let oneBotStatusTimer;
let llmApiKeyConfigured = false;
let availableModelIds = [];

async function requestAdminApi(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: "same-origin", cache: "no-store" });
  const data = await response.json();
  if (response.status === 401 && !url.startsWith("/api/auth/")) {
    showAuthScreen("login", "登录状态已过期，请重新登录。");
  }
  if (!response.ok) throw Object.assign(new Error(data.error || "请求失败，请稍后重试。"), { status: response.status });
  return data;
}

async function requestCommands(options) { return requestAdminApi("/api/commands", options); }
async function requestLlmSettings(options) { return requestAdminApi("/api/llm-settings", options); }
async function requestAccessControl(options) { return requestAdminApi("/api/access-control", options); }

function showAuthScreen(mode, message = "") {
  managementContent.hidden = true;
  authPanel.hidden = false;
  setupForm.hidden = mode !== "setup";
  loginForm.hidden = mode !== "login";
  adminLogout.hidden = true;
  document.querySelector("#auth-title").textContent = mode === "setup" ? "设置管理员密码" : "管理员登录";
  document.querySelector("#auth-description").textContent = mode === "setup"
    ? "首次使用请设置至少 12 个字符的强密码。密码只提交给本机服务端，由服务端计算并保存哈希。"
    : "请输入你此前设置的管理员密码。多次失败后登录会暂时锁定。";
  setupError.textContent = message;
  loginError.textContent = message;
  setupError.hidden = !message || mode !== "setup";
  loginError.hidden = !message || mode !== "login";
  if (mode === "setup") setupPassword.focus();
  if (mode === "login") loginPassword.focus();
}

async function sendAuthRequest(path, password) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "身份验证失败，请稍后再试。");
  return data;
}

async function refreshOneBotStatus() {
  try {
    const data = await requestAdminApi("/api/onebot-status");
    const connected = data.status?.connected === true;
    onebotStatus.textContent = connected ? "NapCat OneBot 已连接" : "NapCat OneBot 未连接";
    onebotStatus.classList.toggle("key-configured", connected);
    onebotStatus.classList.toggle("key-missing", !connected);
    if (typeof data.status?.wsEndpoint === "string") {
      document.querySelector("#onebot-endpoint").textContent = data.status.wsEndpoint;
    }
  } catch {
    onebotStatus.textContent = "NapCat OneBot 状态不可用";
    onebotStatus.classList.add("key-missing");
  }
}

function parseIdList(value) {
  return value.split(/[\s,，;；]+/u).map((id) => id.trim()).filter(Boolean);
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("toast-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("toast-visible"), 3200);
}

function modeLabel(type) {
  return typeNames[type] || typeNames.text;
}

function renderCommands() {
  commandList.replaceChildren();
  commandCount.textContent = `${commands.length} 条指令`;
  emptyState.hidden = commands.length > 0;
  commandList.hidden = commands.length === 0;

  for (const command of commands) {
    const card = document.createElement("article");
    card.className = `command-card${command.id === selectedId ? " command-card-selected" : ""}`;

    const main = document.createElement("button");
    main.className = "command-card-main";
    main.type = "button";
    main.dataset.action = "edit";
    main.dataset.id = command.id;

    const top = document.createElement("span");
    top.className = "command-card-top";
    const name = document.createElement("strong");
    name.className = "command-name";
    name.textContent = command.name;
    const mode = document.createElement("span");
    mode.className = "mode-pill";
    mode.textContent = modeLabel(command.type);
    top.append(name, mode);

    const aliases = document.createElement("span");
    aliases.className = "command-aliases";
    aliases.textContent = command.aliases.length ? `别名：${command.aliases.join("、")}` : "没有设置别名";

    const reply = document.createElement("span");
    reply.className = "command-preview";
    reply.textContent = command.reply;

    main.append(top, aliases, reply);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const edit = document.createElement("button");
    edit.className = "icon-button";
    edit.type = "button";
    edit.dataset.action = "edit";
    edit.dataset.id = command.id;
    edit.setAttribute("aria-label", `编辑 ${command.name}`);
    edit.textContent = "✎";
    const remove = document.createElement("button");
    remove.className = "icon-button icon-button-danger";
    remove.type = "button";
    remove.dataset.action = "delete";
    remove.dataset.id = command.id;
    remove.setAttribute("aria-label", `删除 ${command.name}`);
    remove.textContent = "×";
    actions.append(edit, remove);
    card.append(main, actions);
    commandList.append(card);
  }
}

function updateTypeHint() {
  document.querySelector("#type-hint").textContent = typeHints[fields.type.value];
}

function openEditor(command) {
  selectedId = command.id;
  editorTitle.textContent = "编辑指令";
  editorSubtitle.textContent = "修改触发词或回复内容，保存后立即生效。";
  fields.id.value = command.id;
  fields.name.value = command.name;
  fields.aliases.value = command.aliases.join(", ");
  fields.type.value = command.type;
  fields.reply.value = command.reply;
  document.querySelector("#delete-command").hidden = false;
  form.hidden = false;
  formError.hidden = true;
  updateTypeHint();
  renderCommands();
}

function openNewEditor() {
  selectedId = null;
  editorTitle.textContent = "新建指令";
  editorSubtitle.textContent = "设置一个触发词和机器人回复。";
  fields.id.value = crypto.randomUUID();
  fields.name.value = "";
  fields.aliases.value = "";
  fields.type.value = "text";
  fields.reply.value = "";
  document.querySelector("#delete-command").hidden = true;
  form.hidden = false;
  formError.hidden = true;
  updateTypeHint();
  renderCommands();
  fields.name.focus();
}

async function saveCommands(nextCommands, successMessage) {
  const data = await requestCommands({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands: nextCommands }),
  });
  commands = data.commands;
  renderCommands();
  showToast(successMessage || data.message);
}

async function deleteCommand(id) {
  const command = commands.find((item) => item.id === id);
  if (!command || !window.confirm(`确定删除“${command.name}”指令吗？`)) return;
  const nextCommands = commands.filter((item) => item.id !== id);
  try {
    await saveCommands(nextCommands, `已删除「${command.name}」`);
    selectedId = null;
    form.hidden = true;
    editorTitle.textContent = "选择一条指令";
    editorSubtitle.textContent = "点击左侧指令进行编辑，或新建一条。";
    renderCommands();
  } catch (error) {
    showToast(error.message, true);
  }
}

document.querySelector("#add-command").addEventListener("click", openNewEditor);
document.querySelector("[data-action='new']").addEventListener("click", openNewEditor);
document.querySelector("#cancel-edit").addEventListener("click", () => {
  form.hidden = true;
  selectedId = null;
  editorTitle.textContent = "选择一条指令";
  editorSubtitle.textContent = "点击左侧指令进行编辑，或新建一条。";
  renderCommands();
});
document.querySelector("#delete-command").addEventListener("click", () => deleteCommand(fields.id.value));
fields.type.addEventListener("change", updateTypeHint);

document.querySelectorAll("[data-style-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = stylePresets[button.dataset.stylePreset];
    if (!preset) return;
    const current = llmFields.expressionStyle.value.trim();
    if (current.includes(preset)) {
      showToast("这个预设已在表达风格中。");
      return;
    }
    const next = current ? `${current}\n${preset}` : preset;
    if (next.length > 1000) {
      showToast("表达风格长度已接近上限，请先精简后再添加预设。", true);
      return;
    }
    llmFields.expressionStyle.value = next;
    llmFields.expressionStyle.focus();
  });
});

accessControlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessControlError.hidden = true;
  const accessControl = {
    groupIds: parseIdList(accessControlFields.groupIds.value),
    userIds: parseIdList(accessControlFields.userIds.value),
  };
  const invalidId = [...accessControl.groupIds, ...accessControl.userIds]
    .find((id) => !/^\d{1,32}$/u.test(id));
  if (invalidId) {
    accessControlError.textContent = "每个群号和成员 QQ 号都必须是 1 到 32 位的非空数字。";
    accessControlError.hidden = false;
    return;
  }

  try {
    const data = await requestAccessControl({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessControl }),
    });
    setAccessControl(data.accessControl);
    showToast(data.message);
    await loadGroupPersonas();
  } catch (error) {
    accessControlError.textContent = error.message;
    accessControlError.hidden = false;
  }
});

commandList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  if (button.dataset.action === "delete") {
    void deleteCommand(button.dataset.id);
    return;
  }
  const command = commands.find((item) => item.id === button.dataset.id);
  if (command) openEditor(command);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.hidden = true;
  const aliases = fields.aliases.value.split(/[,，]/u).map((alias) => alias.trim()).filter(Boolean);
  const command = {
    id: fields.id.value,
    name: fields.name.value.trim(),
    aliases,
    type: fields.type.value,
    reply: fields.reply.value,
  };
  const existingIndex = commands.findIndex((item) => item.id === command.id);
  const nextCommands = [...commands];
  if (existingIndex >= 0) nextCommands[existingIndex] = command;
  else nextCommands.push(command);

  try {
    await saveCommands(nextCommands, existingIndex >= 0 ? "指令已更新" : "新指令已创建");
    selectedId = command.id;
    openEditor(commands.find((item) => item.id === selectedId));
  } catch (error) {
    formError.textContent = error.message;
    formError.hidden = false;
  }
});

llmSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  llmSettingsError.hidden = true;
  const settings = {
    apiEndpoint: llmFields.apiEndpoint.value.trim(),
    model: llmFields.model.value.trim(),
    systemPrompt: llmFields.systemPrompt.value,
    personality: llmFields.personality.value,
    expressionStyle: llmFields.expressionStyle.value,
    memory: llmFields.memory.value,
    knowledgeEnabled: llmFields.knowledgeEnabled.checked,
    knowledgeLearningEnabled: llmFields.knowledgeLearningEnabled.checked,
    visualMemoryLearningEnabled: llmFields.visualMemoryLearningEnabled.checked,
    memberImpressionsEnabled: llmFields.memberImpressionsEnabled.checked,
    memberImpressionsLearningEnabled: llmFields.memberImpressionsLearningEnabled.checked,
    stickersEnabled: llmFields.stickersEnabled.checked,
    stickerLearningEnabled: llmFields.stickerLearningEnabled.checked,
    nicknameTriggerEnabled: llmFields.nicknameTriggerEnabled.checked,
    conversationFollowupEnabled: llmFields.conversationFollowupEnabled.checked,
    forwardReadingEnabled: llmFields.forwardReadingEnabled.checked,
    botAliases: llmFields.botAliases.value.split(/[,，、\n]+/u).map((name) => name.trim()).filter(Boolean),
    proactivePauseWhenIgnored: llmFields.proactivePauseWhenIgnored.checked,
    temperature: Number(llmFields.temperature.value),
    maxTokens: Number(llmFields.maxTokens.value),
    modelRetryEnabled: llmFields.modelRetryEnabled.checked,
    longReplyForwardEnabled: llmFields.longReplyForwardEnabled.checked,
    longReplyThreshold: Number(llmFields.longReplyThreshold.value),
    detailedDiscussionEnabled: llmFields.detailedDiscussionEnabled.checked,
    contentSummaryEnabled: llmFields.contentSummaryEnabled.checked,
    summaryOutput: llmFields.summaryOutput.value,
    searchProvider: llmFields.searchProvider.value,
    searchCountry: llmFields.searchCountry.value.trim(),
    searchLanguage: llmFields.searchLanguage.value.trim(),
    searchEnabled: llmFields.searchEnabled.checked,
    visionEnabled: llmFields.visionEnabled.checked,
    chatgptImageGenerationEnabled: llmFields.chatgptImageGenerationEnabled.checked,
    characterRecognitionEnabled: llmFields.characterRecognitionEnabled.checked,
    videoUnderstandingEnabled: llmFields.videoUnderstandingEnabled.checked,
    videoDiscoveryEnabled: llmFields.videoDiscoveryEnabled.checked,
    videoDiscoveryGroupIds: llmFields.videoDiscoveryGroupIds.value.split(/[\s,，、]+/u).map(value => value.trim()).filter(Boolean),
    videoAsrEnabled: llmFields.videoAsrEnabled.checked,
    videoFramesEnabled: llmFields.videoFramesEnabled.checked,
    videoMaxMinutes: Number(llmFields.videoMaxMinutes.value),
    proactiveChatEnabled: llmFields.proactiveChatEnabled.checked,
    proactiveCooldownMinutes: Number(llmFields.proactiveCooldownMinutes.value),
    proactiveFrequencyMinutes: Number(llmFields.proactiveFrequencyMinutes.value),
    proactiveDebounceSeconds: Number(llmFields.proactiveDebounceSeconds.value),
    proactiveDailyLimit: Number(llmFields.proactiveDailyLimit.value),
  };
  const apiKey = llmApiKeyInput.value.trim();

  try {
    const data = await requestLlmSettings({
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings,
        ...(apiKey ? { apiKey } : {}),
        ...(serperKeyInput.value.trim() ? { serperApiKey: serperKeyInput.value.trim() } : {}),
        ...(clearSerperKey.checked ? { clearSerperApiKey: true } : {}),
        ...(clearLlmApiKey.checked ? { clearApiKey: true } : {}),
      }),
    });
    setLlmSettings(data.settings);
    setSearchKeyStatus(data);
    serperKeyInput.value = "";
    clearSerperKey.checked = false;
    llmApiKeyInput.value = "";
    clearLlmApiKey.checked = false;
    llmApiKeyInput.disabled = false;
    if (typeof data.apiKeyConfigured === "boolean") {
      llmApiKeyConfigured = data.apiKeyConfigured;
      setApiKeyStatus(llmApiKeyConfigured);
    }
    localConfigCheck.textContent = data.apiKeyUpdated
      ? "设置已保存；服务端只返回 key 配置状态，没有回显 key。"
      : "设置已保存；未更换现有 API key。";
    showToast(data.message);
  } catch (error) {
    llmSettingsError.textContent = error.message;
    llmSettingsError.hidden = false;
  }
});

function setLlmSettings(settings) {
  llmFields.apiEndpoint.value = settings.apiEndpoint;
  renderModelOptions(settings.model, availableModelIds);
  llmFields.systemPrompt.value = settings.systemPrompt;
  llmFields.personality.value = settings.personality;
  llmFields.expressionStyle.value = settings.expressionStyle;
  llmFields.memory.value = settings.memory ?? "";
  llmFields.knowledgeEnabled.checked = settings.knowledgeEnabled !== false;
  llmFields.knowledgeLearningEnabled.checked = settings.knowledgeLearningEnabled !== false;
  llmFields.visualMemoryLearningEnabled.checked = settings.visualMemoryLearningEnabled !== false;
  llmFields.memberImpressionsEnabled.checked = settings.memberImpressionsEnabled !== false;
  llmFields.memberImpressionsLearningEnabled.checked = settings.memberImpressionsLearningEnabled !== false;
  llmFields.stickersEnabled.checked = settings.stickersEnabled !== false;
  llmFields.stickerLearningEnabled.checked = settings.stickerLearningEnabled !== false;
  llmFields.nicknameTriggerEnabled.checked = settings.nicknameTriggerEnabled !== false;
  llmFields.conversationFollowupEnabled.checked = settings.conversationFollowupEnabled !== false;
  llmFields.forwardReadingEnabled.checked = settings.forwardReadingEnabled !== false;
  llmFields.botAliases.value = (settings.botAliases ?? ["大肥鱼", "肥鱼", "鱼鱼"]).join("、");
  llmFields.proactivePauseWhenIgnored.checked = settings.proactivePauseWhenIgnored !== false;
  llmFields.temperature.value = settings.temperature;
  llmFields.maxTokens.value = settings.maxTokens;
  llmFields.modelRetryEnabled.checked = settings.modelRetryEnabled !== false;
  llmFields.longReplyForwardEnabled.checked = settings.longReplyForwardEnabled !== false;
  llmFields.longReplyThreshold.value = settings.longReplyThreshold ?? 500;
  llmFields.detailedDiscussionEnabled.checked = settings.detailedDiscussionEnabled !== false;
  llmFields.contentSummaryEnabled.checked = settings.contentSummaryEnabled !== false;
  llmFields.summaryOutput.value = settings.summaryOutput ?? "forward";
  llmFields.searchProvider.value = settings.searchProvider;
  llmFields.searchCountry.value = settings.searchCountry;
  llmFields.searchLanguage.value = settings.searchLanguage;
  llmFields.searchEnabled.checked = settings.searchEnabled;
  llmFields.visionEnabled.checked = settings.visionEnabled;
  llmFields.chatgptImageGenerationEnabled.checked = settings.chatgptImageGenerationEnabled === true;
  llmFields.characterRecognitionEnabled.checked = settings.characterRecognitionEnabled !== false;
  llmFields.videoUnderstandingEnabled.checked = settings.videoUnderstandingEnabled !== false;
  llmFields.videoDiscoveryEnabled.checked = settings.videoDiscoveryEnabled === true;
  llmFields.videoDiscoveryGroupIds.value = (settings.videoDiscoveryGroupIds ?? []).join("\n");
  llmFields.videoAsrEnabled.checked = settings.videoAsrEnabled !== false;
  llmFields.videoFramesEnabled.checked = settings.videoFramesEnabled !== false;
  llmFields.videoMaxMinutes.value = settings.videoMaxMinutes ?? 10;
  llmFields.proactiveChatEnabled.checked = settings.proactiveChatEnabled;
  llmFields.proactiveCooldownMinutes.value = settings.proactiveCooldownMinutes;
  llmFields.proactiveFrequencyMinutes.value = settings.proactiveFrequencyMinutes;
  llmFields.proactiveDebounceSeconds.value = settings.proactiveDebounceSeconds;
  llmFields.proactiveDailyLimit.value = settings.proactiveDailyLimit;
}

function renderModelOptions(currentModel, discoveredModelIds) {
  const ids = [...new Set(discoveredModelIds.filter((id) => typeof id === "string" && id.trim()))];
  const options = [];
  if (currentModel && !ids.includes(currentModel)) {
    options.push({ id: currentModel, label: `${currentModel}（当前配置）` });
  }
  for (const id of ids) options.push({ id, label: id });
  llmFields.model.replaceChildren(...options.map(({ id, label }) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    return option;
  }));
  if (currentModel && options.some(({ id }) => id === currentModel)) llmFields.model.value = currentModel;
}

refreshModelsButton.addEventListener("click", async () => {
  const currentModel = llmFields.model.value;
  refreshModelsButton.disabled = true;
  modelListStatus.textContent = "正在向服务端查询模型列表…";
  try {
    const data = await requestAdminApi("/api/llm-models");
    availableModelIds = Array.isArray(data.models) ? data.models : [];
    renderModelOptions(currentModel, availableModelIds);
    modelListStatus.textContent = availableModelIds.length
      ? `已从服务端加载 ${availableModelIds.length} 个模型；选择后保存即可生效。`
      : "服务端返回了空模型列表；当前模型保持不变，没有替换成猜测值。";
  } catch (error) {
    modelListStatus.textContent = `${error.message} 当前模型保持不变。`;
  } finally {
    refreshModelsButton.disabled = false;
  }
});

function setApiKeyStatus(configured) {
  apiKeyStatus.textContent = configured ? "服务端 API key 已配置" : "服务端 API key 未配置";
  apiKeyStatus.classList.toggle("key-configured", configured);
  apiKeyStatus.classList.toggle("key-missing", !configured);
}

function validateLocalApiEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { return false; }
  const path = endpoint.pathname.replace(/\/+$/u, "");
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  return ["https:", "http:"].includes(endpoint.protocol)
    && (endpoint.protocol === "https:" || localHost)
    && !endpoint.username
    && !endpoint.password
    && !endpoint.search
    && !endpoint.hash
    && path.endsWith("/chat/completions");
}

clearLlmApiKey.addEventListener("change", () => {
  if (clearLlmApiKey.checked) llmApiKeyInput.value = "";
  llmApiKeyInput.disabled = clearLlmApiKey.checked;
});

checkLocalConfigButton.addEventListener("click", () => {
  if (!validateLocalApiEndpoint(llmFields.apiEndpoint.value.trim())) {
    localConfigCheck.textContent = "接口地址格式不正确；需使用 HTTPS，且路径以 /chat/completions 结尾。没有发送请求。";
    return;
  }
  const hasNewKey = Boolean(llmApiKeyInput.value.trim());
  const hasKey = clearLlmApiKey.checked ? false : hasNewKey || llmApiKeyConfigured;
  const newKeyValue = llmApiKeyInput.value.trim();
  if (hasNewKey && (!/^[\x21-\x7E]{8,2048}$/u.test(newKeyValue) || newKeyValue.includes("\"") || newKeyValue.includes("'"))) {
    localConfigCheck.textContent = "新 key 格式不正确；请使用不含空格的可见 ASCII 字符。没有发送请求。";
    return;
  }
  localConfigCheck.textContent = hasKey
    ? "本地检查通过：接口格式正常，API key 已配置；没有向模型服务发送请求。"
    : "接口格式正常，但 API key 未配置；没有向模型服务发送请求。";
});

function setAccessControl(accessControl) {
  accessControlFields.groupIds.value = accessControl.groupIds.join("\n");
  accessControlFields.userIds.value = accessControl.userIds.join("\n");
}

async function loadManagementData() {
  await loadMemberImpressions();
  await loadKnowledge();
  await loadVisualMemories();
  await loadStickers();
  await loadGroupPersonas();
  try {
    const data = await requestAccessControl();
    setAccessControl(data.accessControl);
  } catch (error) {
    accessControlError.textContent = error.message;
    accessControlError.hidden = false;
  }

  void refreshOneBotStatus();
  if (oneBotStatusTimer) window.clearInterval(oneBotStatusTimer);
  oneBotStatusTimer = window.setInterval(refreshOneBotStatus, 5000);

  try {
    const data = await requestLlmSettings();
    setLlmSettings(data.settings);
    llmApiKeyConfigured = data.apiKeyConfigured;
    setApiKeyStatus(llmApiKeyConfigured);
    setSearchKeyStatus(data);
  } catch (error) {
    apiKeyStatus.textContent = "模型设置读取失败";
    apiKeyStatus.classList.add("key-missing");
    tavilyKeyStatus.textContent = "搜索设置读取失败";
    tavilyKeyStatus.classList.add("key-missing");
    llmSettingsError.textContent = error.message;
    llmSettingsError.hidden = false;
  }

  try {
    const data = await requestCommands();
    commands = data.commands;
    renderCommands();
  } catch (error) {
    commandCount.textContent = "读取失败";
    commandList.hidden = true;
    showToast(error.message, true);
  }
}

function showManagement() {
  authPanel.hidden = true;
  managementContent.hidden = false;
  adminLogout.hidden = false;
}

async function initializeAuth() {
  try {
    const response = await fetch("/api/auth/state", { credentials: "same-origin", cache: "no-store" });
    const state = await response.json();
    if (!response.ok) throw new Error(state.error || "无法读取管理员状态。");
    if (state.setupRequired) {
      showAuthScreen("setup");
    } else if (state.authenticated) {
      showManagement();
      await loadManagementData();
    } else {
      showAuthScreen("login");
    }
  } catch {
    showAuthScreen("login", "无法读取管理员状态，请刷新页面或检查本机凭据文件。");
  }
}

setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setupError.hidden = true;
  if (setupPassword.value !== setupPasswordConfirm.value) {
    setupError.textContent = "两次输入的密码不一致。";
    setupError.hidden = false;
    return;
  }
  const password = setupPassword.value;
  setupPassword.value = "";
  setupPasswordConfirm.value = "";
  try {
    await sendAuthRequest("/api/auth/setup", password);
    showManagement();
    await loadManagementData();
  } catch (error) {
    setupError.textContent = error.message;
    setupError.hidden = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.hidden = true;
  const password = loginPassword.value;
  loginPassword.value = "";
  try {
    await sendAuthRequest("/api/auth/login", password);
    showManagement();
    await loadManagementData();
  } catch (error) {
    loginError.textContent = error.message;
    loginError.hidden = false;
    loginPassword.focus();
  }
});

adminLogout.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
  } catch {
    // Hide the management UI even if the local server went away during logout.
  } finally {
    if (oneBotStatusTimer) window.clearInterval(oneBotStatusTimer);
    oneBotStatusTimer = null;
    showAuthScreen("login", "已退出管理面板。");
  }
});

const personaForm = document.querySelector("#group-persona-form");
const personaSelect = document.querySelector("#persona-group");
const personaStatus = document.querySelector("#persona-status");
const personaError = document.querySelector("#persona-error");
const personaFields = {
  label: document.querySelector("#persona-label"), enabled: document.querySelector("#persona-enabled"),
  botAliases: document.querySelector("#persona-aliases"), personality: document.querySelector("#persona-personality"),
  expressionStyle: document.querySelector("#persona-style"), memory: document.querySelector("#persona-memory"),
  systemPrompt: document.querySelector("#persona-system-prompt"),
};
let groupPersonas = [];
let personaDefaults = null;
let selectedPersonaId = "";
let personaDirty = false;
let personaLoading = null;

function showSelectedPersona() {
  const profile = groupPersonas.find((item) => item.groupId === selectedPersonaId);
  personaForm.hidden = !profile;
  document.querySelector("#persona-empty").hidden = Boolean(profile);
  personaError.hidden = true;
  personaDirty = false;
  if (!profile) { document.querySelector("#personality-growth-panel").hidden = true; personaStatus.textContent = "没有可配置的授权群。"; return; }
  for (const [key, field] of Object.entries(personaFields)) {
    if (key === "enabled") field.checked = profile.enabled;
    else field.value = key === "botAliases" ? profile.botAliases.join("、") : profile[key];
  }
  document.querySelector("#persona-values").disabled = !profile.enabled;
  personaStatus.textContent = `群 ${profile.groupId} · ${profile.enabled ? "独立人设" : "跟随默认模板"} · 已保存`;
  void loadPersonalityGrowth(profile.groupId);
}

async function loadGroupPersonas({ discard = false } = {}) {
  if (personaDirty && !discard) return;
  if (personaLoading) return personaLoading;
  personaLoading = (async () => {
    try {
      const data = await requestAdminApi("/api/group-personas");
      if (personaDirty && !discard) return;
      groupPersonas = data.profiles;
      personaDefaults = data.defaults;
      if (!groupPersonas.some((item) => item.groupId === selectedPersonaId)) selectedPersonaId = groupPersonas[0]?.groupId ?? "";
      personaSelect.replaceChildren(...groupPersonas.map((profile) => {
        const option = document.createElement("option"); option.value = profile.groupId;
        option.textContent = (profile.label ? `${profile.label} · ` : "群 ") + profile.groupId + (profile.enabled ? " · 独立人设" : " · 默认模板");
        return option;
      }));
      personaSelect.value = selectedPersonaId;
      personaSelect.disabled = groupPersonas.length === 0;
      showSelectedPersona();
    } catch (error) { personaStatus.textContent = error.message; }
    finally { personaLoading = null; }
  })();
  return personaLoading;
}

personaSelect.addEventListener("change", () => {
  if (personaDirty) { personaSelect.value = selectedPersonaId; showToast("请先保存当前群人设，或点击撤销修改后再切换。", true); return; }
  selectedPersonaId = personaSelect.value;
  showSelectedPersona();
});
personaForm.addEventListener("input", () => {
  personaDirty = true;
  document.querySelector("#persona-values").disabled = !personaFields.enabled.checked;
  personaStatus.textContent = `群 ${selectedPersonaId} · 有未保存的修改`;
});
document.querySelector("#reset-persona").addEventListener("click", () => loadGroupPersonas({ discard: true }));
document.querySelector("#copy-default-persona").addEventListener("click", () => {
  if (!personaDefaults) return;
  for (const key of ["systemPrompt", "personality", "expressionStyle", "botAliases", "memory"]) {
    personaFields[key].value = key === "memory" ? "" : key === "botAliases" ? personaDefaults[key].join("、") : personaDefaults[key];
  }
  personaFields.enabled.checked = true;
  document.querySelector("#persona-values").disabled = false;
  personaDirty = true;
  personaStatus.textContent = `群 ${selectedPersonaId} · 默认模板已填入，本群记忆为空，保存后生效`;
});
personaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const current = groupPersonas.find((item) => item.groupId === selectedPersonaId);
  if (!current) return;
  const profile = { label: personaFields.label.value, enabled: personaFields.enabled.checked,
    botAliases: personaFields.botAliases.value.split(/[,，、\n]+/u).map((name) => name.trim()).filter(Boolean),
    personality: personaFields.personality.value, expressionStyle: personaFields.expressionStyle.value,
    memory: personaFields.memory.value, systemPrompt: personaFields.systemPrompt.value };
  const button = document.querySelector("#save-persona"); button.disabled = true; personaSelect.disabled = true; personaError.hidden = true;
  try {
    const data = await requestAdminApi(`/api/group-personas/${current.groupId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile, revision: current.revision }) });
    groupPersonas = groupPersonas.map((item) => item.groupId === current.groupId ? data.profile : item);
    personaDirty = false;
    await loadGroupPersonas();
    showToast(data.message);
  } catch (error) { personaError.textContent = error.message; personaError.hidden = false; }
  finally { button.disabled = false; personaSelect.disabled = groupPersonas.length === 0; }
});
personaForm.addEventListener("invalid", (event) => { const detail = event.target.closest("details"); if (detail) detail.open = true; }, true);

let personalityGrowthData = null, personalityGrowthLoad = 0, personalityGrowthBusy = false;
const growthPanel = document.querySelector("#personality-growth-panel");
function renderPersonalityGrowth(data) {
  growthPanel.hidden = false;
  document.querySelector("#personality-growth-enabled").checked = data.enabled;
  document.querySelector("#personality-growth-learning").checked = data.learningEnabled;
  document.querySelector("#rollback-personality-growth").disabled = !data.rollbackId;
  document.querySelector("#unblock-personality-growth").hidden = !data.blocked.length;
  const growthOutcomes = { waiting: "等待新的互动反馈", observed: "最近已积累互动反馈", "no-accepted-feedback": "最近未发现可采用的新反馈，或旧任务已失效", "persona-changed": "基础人设已变更，旧任务未写入", "storage-error": "成长记录保存失败，请检查本机资料文件", "model-error": "最近整理模型失败，有效短期缓冲将重试" };
  document.querySelector("#personality-growth-status").textContent = `群 ${data.groupId} · ${data.enabled ? "成长效果启用" : "成长效果停用"} · ${data.learningEnabled ? "继续观察互动" : "已暂停积累"} · 已形成${data.habits.length}项习惯`
    + (!data.baselineMatches ? " · 基础人设已变更，旧成长暂停套用，等待新互动" : "")
    + (data.lastReflection ? ` · 最近反思${new Date(data.lastReflection.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : " · 尚无可用的新反馈，不会人为补写成长")
    + (data.blocked.length ? ` · 已撤回方向：${data.blocked.join("、")}` : "")
    + ` · ${growthOutcomes[data.learning?.outcome] ?? "等待反馈"}（短期缓冲${data.learning?.buffered ?? 0}条）`;
  const list = (selector, lines, empty) => { const container = document.querySelector(selector); container.replaceChildren();
    for (const line of lines.length ? lines : [empty]) { const item = document.createElement("p"); item.className = "field-hint"; item.textContent = line; container.append(item); } };
  list("#personality-growth-habits", data.habits.map(habit => `${habit.label}：${habit.description} · ${habit.evidenceCount}条互动依据 · ${new Date(habit.since).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`), "尚未形成新的相处习惯，继续按基础人设自然聊天。");
  list("#personality-growth-candidates", data.candidates.map(candidate => `${candidate.label} → ${candidate.description} · ${candidate.evidenceCount}条反馈 · ${candidate.ready ? "已满足基础证据，等待节奏与分歧核对" : "继续观察，不直接采用"}`), "暂无待观察的反馈。");
  list("#personality-growth-journal", data.journal.map(entry => `${new Date(entry.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · ${entry.summary}`), "暂无成长记录；空白表示还没有发生对应调整。");
}
async function loadPersonalityGrowth(groupId = selectedPersonaId) {
  const sequence = ++personalityGrowthLoad;
  if (personalityGrowthData?.groupId !== groupId) {
    for (const id of ["personality-growth-habits", "personality-growth-candidates", "personality-growth-journal"]) document.getElementById(id).replaceChildren();
    document.querySelector("#personality-growth-status").textContent = "正在读取本群成长记录…";
  }
  personalityGrowthData = null;
  if (!groupId) { growthPanel.hidden = true; return; }
  try {
    const result = await requestAdminApi(`/api/personality-growth?groupId=${encodeURIComponent(groupId)}`);
    if (sequence !== personalityGrowthLoad || groupId !== selectedPersonaId) return;
    personalityGrowthData = { ...result.growth, learning: result.learning }; renderPersonalityGrowth(personalityGrowthData);
  } catch (error) {
    if (sequence !== personalityGrowthLoad || groupId !== selectedPersonaId) return;
    growthPanel.hidden = false; document.querySelector("#personality-growth-status").textContent = error.message;
  }
}
async function controlPersonalityGrowth(action) {
  const current = personalityGrowthData;
  if (!current || current.groupId !== selectedPersonaId) return;
  personalityGrowthBusy = true;
  const controls = [...growthPanel.querySelectorAll("button,input")]; controls.forEach(control => { control.disabled = true; });
  try {
    const result = await requestAdminApi("/api/personality-growth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      groupId: current.groupId, revision: current.revision, action, changeId: current.rollbackId,
      enabled: document.querySelector("#personality-growth-enabled").checked, learningEnabled: document.querySelector("#personality-growth-learning").checked,
    }) });
    if (current.groupId === selectedPersonaId) { personalityGrowthData = { ...result.growth, learning: result.learning }; renderPersonalityGrowth(personalityGrowthData); }
    showToast(result.message);
  } catch (error) { showToast(error.message, true); }
  finally { controls.forEach(control => { control.disabled = false; }); personalityGrowthBusy = false; await loadPersonalityGrowth(); }
}
document.querySelector("#personality-growth-enabled").addEventListener("change", () => void controlPersonalityGrowth("settings"));
document.querySelector("#personality-growth-learning").addEventListener("change", () => void controlPersonalityGrowth("settings"));
document.querySelector("#refresh-personality-growth").addEventListener("click", () => void loadPersonalityGrowth());
document.querySelector("#rollback-personality-growth").addEventListener("click", () => void controlPersonalityGrowth("rollback"));
document.querySelector("#unblock-personality-growth").addEventListener("click", () => void controlPersonalityGrowth("unblock"));
setInterval(() => { if (!personalityGrowthBusy && !managementContent.hidden && !document.querySelector("#page-personas").hidden && !personaDirty) void loadPersonalityGrowth(); }, 15000);

let knowledgeEntries = [];
let knowledgeRevisionValue = "";
let knowledgeRefreshTimer;
let selectedKnowledgeGroup;
let knowledgeLoadSequence = 0;
let knowledgeMaintenance = null;
const knowledgeGroupSelect = document.querySelector("#knowledge-group");
const knowledgeList = document.querySelector("#knowledge-list");
const knowledgeForm = document.querySelector("#knowledge-form");
const knowledgeFields = {
  id: document.querySelector("#knowledge-id"),
  title: document.querySelector("#knowledge-title"),
  tags: document.querySelector("#knowledge-tags"),
  content: document.querySelector("#knowledge-content"),
  enabled: document.querySelector("#knowledge-entry-enabled"),
};

function renderKnowledge() {
  const candidateCount = knowledgeEntries.filter(entry => !entry.archivedAt && entry.reviewStatus === "candidate").length;
  document.querySelector("#knowledge-count").textContent = `${knowledgeEntries.length} 条知识，${knowledgeEntries.filter((entry) => entry.enabled).length} 条已启用，${candidateCount} 条待确认`;
  document.querySelector("#show-knowledge-candidates").textContent = `查看待确认知识（${candidateCount}）`;
  knowledgeList.replaceChildren();
  if (!knowledgeEntries.length) {
    const empty = document.createElement("p");
    empty.className = "field-hint";
    empty.textContent = "当前知识库还没有条目。可以手动添加，或等待本群聊天积累；其他群的知识不会显示在这里。";
    knowledgeList.append(empty);
  }
  const query = document.querySelector("#knowledge-filter").value.trim().toLocaleLowerCase("zh-CN");
  const origin = document.querySelector("#knowledge-origin-filter").value;
  const filtered = knowledgeEntries.filter((entry) => (!query || `${entry.title} ${entry.tags.join(" ")} ${entry.content}`.toLocaleLowerCase("zh-CN").includes(query))
    && (origin === "archived" ? Boolean(entry.archivedAt) : !entry.archivedAt && (origin === "all" || (origin === "manual" ? entry.origin !== "group" : entry.origin === "group" && (origin === "candidate" || origin === "rejected" ? entry.reviewStatus === origin : entry.reviewStatus === "learned")))));
  for (const entry of filtered) {
    const card = document.createElement("div");
    card.className = "command-card";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "command-card-main";
    const title = document.createElement("strong");
    title.className = "command-name";
    title.textContent = `${entry.archivedAt ? "[已归档] " : entry.reviewStatus === "candidate" ? "[待确认] " : entry.reviewStatus === "rejected" ? "[已拒绝] " : entry.enabled ? "" : "[已停用] "}${entry.title}`;
    const tags = document.createElement("span");
    tags.className = "command-aliases";
    tags.textContent = entry.tags.join("、") || "未设置关键词";
    const preview = document.createElement("span");
    preview.className = "command-preview";
    preview.textContent = entry.content;
    const source = document.createElement("span");
    source.className = "knowledge-source";
    source.textContent = knowledgeSourceLabel(entry);
    edit.append(title, source, tags, preview);
    edit.addEventListener("click", () => openKnowledgeEditor(entry));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button icon-button-danger";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `删除 ${entry.title}`);
    remove.addEventListener("click", async () => {
      if (!window.confirm(`确定删除“${entry.title}”知识吗？`)) return;
      try {
        await saveKnowledge(knowledgeEntries.filter((item) => item.id !== entry.id));
        if (knowledgeFields.id.value === entry.id) knowledgeForm.hidden = true;
      } catch (error) { showToast(error.message, true); }
    });
    card.append(edit, remove);
    if (entry.relatedStickerIds?.length) {
      const related = document.createElement("button"); related.type = "button"; related.className = "button button-quiet"; related.textContent = "查看关联表情";
      related.addEventListener("click", async () => {
        try { selectedStickerPreferenceGroup = selectedKnowledgeGroup; document.querySelector('[data-page="stickers"]').click(); await loadStickers();
          const sticker = stickers.find(item => entry.relatedStickerIds.includes(item.id) && (!item.groupId || item.groupId === selectedKnowledgeGroup));
          if (sticker) openStickerEditor(sticker); else showToast("关联表情已删除或不属于当前群。", true);
        } catch (error) { showToast(error.message, true); }
      }); card.append(related);
    }
    if (entry.reviewStatus === "candidate" && !entry.archivedAt) {
      const controls = document.createElement("div"); controls.className = "form-actions";
      for (const [label, accepted] of [["确认并启用", true], ["拒绝此候选", false]]) {
        const button = document.createElement("button"); button.type = "button"; button.className = "button button-quiet"; button.textContent = label;
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await saveKnowledge(knowledgeEntries.map(item => item.id === entry.id ? { ...item, enabled: accepted, reviewStatus: accepted ? "learned" : "rejected", reviewDecision: accepted ? "approved" : "rejected" }
            : accepted && entry.supersedesId === item.id ? { ...item, enabled: false, reviewDecision: "approved" } : item)); }
          catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
        }); controls.append(button);
      }
      card.append(controls);
    }
    knowledgeList.append(card);
  }
}

function knowledgeSourceLabel(entry) {
  if (entry?.archivedAt) return `已归档 · ${entry.archiveReason === "duplicate" ? "完全重复，证据已合并" : "长期未获新支持"} · ${new Date(entry.archivedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · 可编辑并启用恢复`;
  if (entry?.origin !== "group") return entry?.groupId ? `手动添加 · 仅群 ${entry.groupId}` : selectedKnowledgeGroup ? `手动添加 · 仅群 ${selectedKnowledgeGroup}` : "手动添加 · 仅私聊资料";
  const date = entry.updatedAt ? new Date(entry.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return `${entry.reviewStatus === "candidate" ? "待确认" : entry.reviewStatus === "rejected" ? "已拒绝" : "群聊积累"} · 群 ${entry.groupId} · ${entry.evidenceCount ?? 0} 条支持 · ${date}`
    + (entry.evidenceRefs?.length ? ` · 已保存${entry.evidenceRefs.length}条来源指纹（不含原文）` : "")
    + (entry.relatedStickerIds?.length ? ` · 关联表情：${entry.relatedStickerIds.map(id => id.slice(0, 8)).join("、")}` : " · 未关联具体表情")
    + (entry.supersedesId ? " · 对已有知识的修正，需确认" : "")
    + (entry.requiresReview && !entry.reviewDecision ? " · 角色或事实类候选，不因多人复述自动启用" : "");
}

function openKnowledgeEditor(entry = null) {
  knowledgeFields.id.value = entry?.id ?? crypto.randomUUID();
  knowledgeFields.title.value = entry?.title ?? "";
  knowledgeFields.tags.value = entry?.tags.join(", ") ?? "";
  knowledgeFields.content.value = entry?.content ?? "";
  knowledgeFields.enabled.checked = entry?.enabled ?? true;
  document.querySelector("#knowledge-source").textContent = knowledgeSourceLabel(entry);
  knowledgeForm.hidden = false;
  knowledgeFields.title.focus();
}

async function loadKnowledge({ force = false } = {}) {
  if (!force && !knowledgeForm.hidden) return;
  const sequence = ++knowledgeLoadSequence;
  try {
    const suffix = selectedKnowledgeGroup === undefined ? "" : `?groupId=${encodeURIComponent(selectedKnowledgeGroup ?? "private")}`;
    const data = await requestAdminApi("/api/knowledge" + suffix);
    if (sequence !== knowledgeLoadSequence) return;
    selectedKnowledgeGroup = data.groupId;
    knowledgeGroupSelect.replaceChildren(...[...data.groups.map((groupId) => ({ value: groupId, label: `群 ${groupId}` })), { value: "private", label: "私聊资料（与群聊隔离）" }].map(({value,label}) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
    }));
    knowledgeGroupSelect.value = data.groupId ?? "private";
    document.querySelector("#extract-knowledge").disabled = data.groupId === null;
    knowledgeEntries = data.entries;
    knowledgeMaintenance = data.maintenance;
    renderMemoryMaintenance("knowledge", data.maintenance);
    knowledgeRevisionValue = data.revision;
    const states = data.learning?.groups ?? [];
    const buffered = states.reduce((sum, state) => sum + state.bufferedMessages, 0);
    const outcomes = { waiting: "等待合并提炼", "waiting-context": "等待更多上下文", learning: "正在提炼", saved: "本轮知识已有新增或更新，请查看条目和待确认状态", "members-only": "本轮只更新了成员印象，没有新增群知识", "growth-only": "本轮积累了相处反馈，详情在分群人设的性格成长中", "no-facts": "上次未发现新知识或与已有条目重复", "model-error": "提炼失败，有效短期缓冲会重试", "daily-limit": "旧版达到每日上限；新版已取消，等待新消息", "missing-key": "服务端未配置模型密钥", filtered: "本次明确教学未进入提炼：内容过长或含不应保存的信息", "buffer-cleared": "服务重启或缓冲已清理，等待新的群消息", expired: "短期缓冲已到期，等待新消息" };
    const latest = [...states].sort((a, b) => (b.lastAttemptAt || b.lastReceivedAt || 0) - (a.lastAttemptAt || a.lastReceivedAt || 0))[0];
    document.querySelector("#knowledge-learning-status").textContent = data.groupId === null ? "私聊资料由管理员手动维护，与所有群聊知识隔离。"
      : data.oneBotConnected === false ? "OneBot 未连接，暂时收不到群聊；本群已有知识仍保存在本机。"
      : `群 ${data.groupId} · 当前缓冲 ${buffered} 条可积累消息${latest ? " · " + (outcomes[latest.outcome] ?? "正在观察") + `（知识新增/更新 ${latest.lastKnowledgeAddedCount ?? 0} 条，成员印象 ${latest.lastMemberAddedCount ?? 0} 条）` : " · 等待本群群友解释网梗或互动背景"}`;
    if (data.groupId !== null && latest) document.querySelector("#knowledge-learning-status").textContent +=
      ` · 今日知识提炼${latest.attemptsToday ?? 0}次（无每日上限）` + (latest.lastKnowledgeSavedAt ? ` · 最近新增/更新知识：${new Date(latest.lastKnowledgeSavedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` : " · 尚无新版知识保存时间记录")
      + (!buffered ? " · 原始聊天缓冲不跨重启保留，已有知识与状态会保留" : "");
    renderKnowledge();
  } catch (error) {
    if (sequence !== knowledgeLoadSequence) return;
    if (error.status === 404 && selectedKnowledgeGroup !== undefined && knowledgeForm.hidden) {
      selectedKnowledgeGroup = undefined;
      await loadKnowledge();
      return;
    }
    document.querySelector("#knowledge-count").textContent = error.message;
  } finally {
    clearTimeout(knowledgeRefreshTimer);
    knowledgeRefreshTimer = setTimeout(() => {
      if (!managementContent.hidden && !document.querySelector("#page-knowledge").hidden && knowledgeForm.hidden) void loadKnowledge();
    }, 10000);
  }
}

async function saveKnowledge(entries) {
  if (selectedKnowledgeGroup === undefined) throw new Error("请先等待知识库读取完成。");
  let data;
  knowledgeGroupSelect.disabled = true;
  try { data = await requestAdminApi("/api/knowledge", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: selectedKnowledgeGroup, entries, revision: knowledgeRevisionValue }) }); }
  catch (error) { if (error.status === 409) await loadKnowledge({ force: true }); throw error; }
  finally { knowledgeGroupSelect.disabled = false; }
  knowledgeEntries = data.entries;
  knowledgeRevisionValue = data.revision;
  renderKnowledge();
  showToast(data.message);
}

document.querySelector("#add-knowledge").addEventListener("click", () => openKnowledgeEditor());
document.querySelector("#show-knowledge-candidates").addEventListener("click", () => { document.querySelector("#knowledge-origin-filter").value = "candidate"; renderKnowledge(); });
document.querySelector("#extract-knowledge").addEventListener("click", async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try { const data = await requestAdminApi("/api/knowledge/learn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: selectedKnowledgeGroup }) }); showToast(data.message); await loadKnowledge(); }
  catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});
document.querySelector("#cancel-knowledge").addEventListener("click", () => { knowledgeForm.hidden = true; void loadKnowledge(); });
knowledgeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const entry = {
    ...(knowledgeEntries.find((item) => item.id === knowledgeFields.id.value) ?? {}),
    id: knowledgeFields.id.value,
    title: knowledgeFields.title.value,
    tags: knowledgeFields.tags.value.split(/[,，、\n]+/u).map((tag) => tag.trim()).filter(Boolean),
    content: knowledgeFields.content.value,
    enabled: knowledgeFields.enabled.checked,
    groupId: selectedKnowledgeGroup,
    reviewStatus: knowledgeFields.enabled.checked ? "learned" : (knowledgeEntries.find((item) => item.id === knowledgeFields.id.value)?.reviewStatus ?? "learned"),
    reviewDecision: knowledgeFields.enabled.checked ? "approved" : (knowledgeEntries.find(item => item.id === knowledgeFields.id.value)?.reviewDecision ?? null),
  };
  if (entry.enabled) { entry.reviewStatus = "learned"; entry.archivedAt = null; entry.archiveReason = null; entry.mergedInto = null; }
  const exists = knowledgeEntries.some((item) => item.id === entry.id);
  const entries = exists ? knowledgeEntries.map((item) => item.id === entry.id ? entry : item) : [...knowledgeEntries, entry];
  const button = knowledgeForm.querySelector('[type="submit"]');
  button.disabled = true;
  try { await saveKnowledge(entries); knowledgeForm.hidden = true; void loadKnowledge(); }
  catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#knowledge-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = document.querySelector("#knowledge-results");
  output.hidden = false;
  output.textContent = "正在本机检索…";
  try {
    const scope = selectedKnowledgeGroup;
    const data = await requestAdminApi("/api/knowledge/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: scope, query: document.querySelector("#knowledge-query").value }) });
    if (selectedKnowledgeGroup !== scope) return;
    output.textContent = data.results.length ? data.results.map((result) => `${result.title}\n${result.excerpt}`).join("\n\n────────\n\n") : "没有匹配条目。可以给知识增加群友常用的简称或近义词，再试一次。";
  } catch (error) { output.textContent = error.message; }
});

document.querySelector("#knowledge-filter").addEventListener("input", renderKnowledge);
document.querySelector("#knowledge-origin-filter").addEventListener("change", renderKnowledge);
knowledgeGroupSelect.addEventListener("change", async () => {
  if (!knowledgeForm.hidden) { knowledgeGroupSelect.value = selectedKnowledgeGroup ?? "private"; showToast("先保存或取消当前条目的编辑，再切换群。", true); return; }
  selectedKnowledgeGroup = knowledgeGroupSelect.value === "private" ? null : knowledgeGroupSelect.value;
  knowledgeEntries = []; knowledgeRevisionValue = "";
  document.querySelector("#knowledge-results").hidden = true;
  renderKnowledge();
  await loadKnowledge();
});

let stickers = [];
let stickerPreviewUrl = null;
let stickerRefreshTimer = null;
const stickerForm = document.querySelector("#sticker-form");
const stickerFields = Object.fromEntries(["id", "title", "tags", "usage", "avoid", "file", "entry-enabled"].map((key) => [key, document.querySelector(`#sticker-${key}`)]));
let stickerPreferences = { rules: [], revision: null }, selectedStickerPreferenceGroup = null, preferenceLoadSequence = 0;
const preferenceGroup = document.querySelector("#sticker-preference-group");
async function loadStickerPreferences() {
  const sequence = ++preferenceLoadSequence;
  const data = await requestAdminApi("/api/sticker-preferences" + (selectedStickerPreferenceGroup ? `?groupId=${encodeURIComponent(selectedStickerPreferenceGroup)}` : ""));
  if (sequence !== preferenceLoadSequence) return;
  stickerPreferences = data; selectedStickerPreferenceGroup = data.groupId;
  preferenceGroup.replaceChildren(...data.groups.map(id => { const option = document.createElement("option"); option.value = id; option.textContent = `群 ${id}`; return option; }));
  preferenceGroup.value = data.groupId ?? "";
  document.querySelector("#add-sticker-block-term").disabled = !data.groupId;
  renderStickerPreferences();
}
async function saveStickerRules(rules) {
  if (!selectedStickerPreferenceGroup) return;
  const groupId = selectedStickerPreferenceGroup, revision = stickerPreferences.revision;
  try { await requestAdminApi("/api/sticker-preferences", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId, rules, revision }) }); }
  finally { await loadStickerPreferences(); renderStickers(); }
}
function renderStickerPreferences() {
  const container = document.querySelector("#sticker-preference-rules"); container.replaceChildren();
  if (!stickerPreferences.rules.length) { const hint = document.createElement("p"); hint.className = "field-hint"; hint.textContent = "本群暂无禁用或待确认偏好。"; container.append(hint); }
  for (const rule of stickerPreferences.rules) {
    const row = document.createElement("div"); row.className = "preference-row";
    const text = document.createElement("span");
    const title = rule.kind === "term" ? `关键词：${rule.value}` : stickers.find(entry => entry.id === rule.value)?.title ?? "已删除或未找到的表情";
    const temporary = rule.status === "candidate" && Date.now() - rule.at < 15 * 60_000;
    text.textContent = `${rule.status === "blocked" ? "已禁用" : rule.status === "dismissed" ? "已驳回" : "待确认"} · ${title}${temporary ? " · 临时避开中" : ""}`;
    row.append(text);
    if (rule.status === "candidate") {
      const approve = document.createElement("button"); approve.type = "button"; approve.className = "button button-quiet"; approve.textContent = "确认本群禁用";
      approve.addEventListener("click", async () => { approve.disabled = true; try { await saveStickerRules(stickerPreferences.rules.map(x => x.id === rule.id ? { ...x, status: "blocked" } : x)); } catch (error) { showToast(error.message, true); } }); row.append(approve);
    }
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "button button-quiet"; remove.textContent = rule.status === "candidate" ? "驳回" : "移除";
    remove.addEventListener("click", async () => { remove.disabled = true; try { await saveStickerRules(rule.status === "candidate" ? stickerPreferences.rules.map(x => x.id === rule.id ? { ...x, status: "dismissed" } : x) : stickerPreferences.rules.filter(x => x.id !== rule.id)); } catch (error) { showToast(error.message, true); } }); row.append(remove); container.append(row);
  }
}
preferenceGroup.addEventListener("change", async () => { selectedStickerPreferenceGroup = preferenceGroup.value; try { await loadStickerPreferences(); renderStickers(); } catch (error) { showToast(error.message, true); } });
document.querySelector("#add-sticker-block-term").addEventListener("click", async () => {
  const input = document.querySelector("#sticker-block-term"), value = input.value.trim(); if (!value) return;
  try { await saveStickerRules([...stickerPreferences.rules, { id: crypto.randomUUID(), kind: "term", value, status: "blocked", origin: "admin", at: Date.now() }]); input.value = ""; } catch (error) { showToast(error.message, true); }
});

async function loadStickers() {
  try { stickers = (await requestAdminApi("/api/stickers")).stickers; await loadStickerPreferences(); renderStickers(); }
  catch (error) { document.querySelector("#sticker-count").textContent = error.message; }
  finally {
    clearTimeout(stickerRefreshTimer);
    stickerRefreshTimer = setTimeout(() => {
      if (!managementContent.hidden && !document.querySelector("#page-stickers").hidden && stickerForm.hidden) void loadStickers();
    }, 10000);
  }
}

function renderStickers() {
  const list = document.querySelector("#sticker-list");
  list.replaceChildren();
  document.querySelector("#sticker-count").textContent = stickers.length ? `${stickers.length} 张表情，${stickers.filter((entry) => entry.enabled).length} 张启用，${stickers.filter((entry) => entry.origin === "group").length} 张从群聊学来` : "还没有表情包。可以上传，也可以等 bot 从群友发来的 GIF 或 QQ 表情里学习收藏。";
  for (const sticker of stickers) {
    const card = document.createElement("article"); card.className = "sticker-card";
    const image = document.createElement("img"); if (sticker.reviewStatus === "approved") image.src = `/api/stickers/${sticker.id}/image`; image.alt = sticker.reviewStatus === "approved" ? sticker.title : "内容检查中，暂不展示"; image.loading = "lazy";
    const title = document.createElement("p"); title.textContent = (sticker.enabled ? "" : "[停用] ") + sticker.title;
    const tags = document.createElement("p"); tags.className = "field-hint"; tags.textContent = sticker.tags.join("、") || "建议补充情绪或场景关键词";
    const source = document.createElement("p"); source.className = "field-hint";
    source.textContent = (sticker.origin === "group" ? `群聊学会 · 仅群 ${sticker.groupId}` : "手动上传 · 通用表情")
      + (sticker.needsDescription ? " · 正在学习用途" : "")
      + (sticker.reviewStatus === "approved" ? " · 内容已检查" : " · 内容待检查，暂不发送")
      + (sticker.firstFrameOnly ? " · 收藏静态首帧" : sticker.animationReduced ? " · 动画已压缩" : "");
    const usage = document.createElement("p"); usage.className = "field-hint"; usage.textContent = sticker.usage ? `适合：${sticker.usage}` : "用途待学习，学好前暂不自动使用。";
    const avoid = document.createElement("p"); avoid.className = "field-hint"; avoid.textContent = sticker.avoid ? `避免：${sticker.avoid}` : "";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "button button-quiet"; edit.textContent = "编辑"; edit.addEventListener("click", () => openStickerEditor(sticker));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "button button-danger-text"; remove.textContent = "删除";
    remove.addEventListener("click", async () => { if (!window.confirm(`删除“${sticker.title}”表情？`)) return; try { await requestAdminApi(`/api/stickers/${sticker.id}`, { method: "DELETE" }); if (stickerFields.id.value === sticker.id) stickerForm.hidden = true; await loadStickers(); } catch (error) { showToast(error.message, true); } });
    card.append(image, title, tags, source, usage, avoid, edit, remove); list.append(card);
    if (selectedStickerPreferenceGroup && (!sticker.groupId || sticker.groupId === selectedStickerPreferenceGroup)) {
      const blocked = stickerPreferences.rules.find(rule => rule.kind === "sticker" && rule.value === sticker.id && rule.status === "blocked");
      const scopeButton = document.createElement("button"); scopeButton.type = "button"; scopeButton.className = "button button-quiet";
      scopeButton.textContent = blocked ? "移除此图的本群禁用" : "仅本群禁用此图";
      scopeButton.addEventListener("click", async () => { scopeButton.disabled = true; try {
        const rules = stickerPreferences.rules.filter(rule => !(rule.kind === "sticker" && rule.value === sticker.id));
        if (!blocked) rules.push({ id: crypto.randomUUID(), kind: "sticker", value: sticker.id, status: "blocked", origin: "admin", at: Date.now() });
        await saveStickerRules(rules);
      } catch (error) { showToast(error.message, true); } finally { scopeButton.disabled = false; } }); card.append(scopeButton);
    }
  }
}

function openStickerEditor(sticker = null) {
  stickerForm.reset();
  stickerFields.id.value = sticker?.id ?? "";
  stickerFields.title.value = sticker?.title ?? "";
  stickerFields.tags.value = sticker?.tags.join(", ") ?? "";
  stickerFields.usage.value = sticker?.usage ?? "";
  stickerFields.avoid.value = sticker?.avoid ?? "";
  stickerFields["entry-enabled"].checked = sticker?.enabled ?? true;
  stickerFields.file.required = !sticker;
  stickerFields.file.disabled = Boolean(sticker);
  if (stickerPreviewUrl) URL.revokeObjectURL(stickerPreviewUrl);
  stickerPreviewUrl = null;
  const preview = document.querySelector("#sticker-preview");
  preview.hidden = !sticker;
  if (sticker) preview.src = `/api/stickers/${sticker.id}/image`; else preview.removeAttribute("src");
  stickerForm.hidden = false;
  stickerFields.title.focus();
}

document.querySelector("#add-sticker").addEventListener("click", () => openStickerEditor());
document.querySelector("#refresh-stickers").addEventListener("click", loadStickers);
document.querySelector("#cancel-sticker").addEventListener("click", () => { stickerForm.hidden = true; });
stickerFields.file.addEventListener("change", () => {
  const file = stickerFields.file.files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { showToast("每张图片或 GIF 表情最多 20 MB。", true); stickerFields.file.value = ""; return; }
  if (!stickerFields.title.value) stickerFields.title.value = file.name.replace(/\.[^.]+$/u, "").slice(0, 80);
  if (stickerPreviewUrl) URL.revokeObjectURL(stickerPreviewUrl);
  stickerPreviewUrl = URL.createObjectURL(file);
  const preview = document.querySelector("#sticker-preview"); preview.src = stickerPreviewUrl; preview.hidden = false;
});
stickerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = stickerForm.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const input = { title: stickerFields.title.value.trim(), tags: stickerFields.tags.value.split(/[,，、\n]+/u).map((tag) => tag.trim()).filter(Boolean),
      usage: stickerFields.usage.value.trim(), avoid: stickerFields.avoid.value.trim(), enabled: stickerFields["entry-enabled"].checked };
    const id = stickerFields.id.value;
    if (!id) {
      const file = stickerFields.file.files[0];
      if (!file) throw new Error("请先选择表情图片。");
      input.base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("无法读取图片。")); reader.readAsDataURL(file); });
    }
    await requestAdminApi(id ? `/api/stickers/${id}` : "/api/stickers", { method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    stickerForm.hidden = true;
    await loadStickers();
    showToast(input.usage ? "表情和使用场景已保存。" : "表情已保存，正在学习适合使用的场景。");
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});

for (const key of ["knowledgeEnabled", "knowledgeLearningEnabled", "memberImpressionsEnabled", "memberImpressionsLearningEnabled", "stickersEnabled", "stickerLearningEnabled", "visualMemoryLearningEnabled"]) {
  llmFields[key].addEventListener("change", async () => {
    const checked = llmFields[key].checked;
    llmFields[key].disabled = true;
    try { await requestAdminApi("/api/features", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: checked }) }); showToast("开关已保存，立即生效。"); }
    catch (error) { llmFields[key].checked = !checked; showToast(error.message, true); }
    finally { llmFields[key].disabled = false; }
  });
}

let selectedMemberGroup = "";
let memberData = { members: [], revision: null, groups: [] };
let memberDraft = null;
let memberLoadSequence = 0;
let memberRefreshTimer;
const memberForm = document.querySelector("#member-form");
const memberGroupSelect = document.querySelector("#member-group");
const memberKindNames = { preference: "娱乐偏好", interest: "兴趣话题", interaction: "互动习惯", nickname: "称呼偏好" };
function renderMemoryMaintenance(prefix, data) {
  const status = document.querySelector(`#${prefix}-maintenance-status`), button = document.querySelector(`#maintain-${prefix}-memory`);
  button.disabled = !data;
  if (!data) { status.textContent = "请选择已授权群；私聊资料单独维护。"; return; }
  const last = data.last;
  status.textContent = `知识：${data.knowledge.active}条启用、${data.knowledge.pending}条待确认、${data.knowledge.archived}条归档；成员印象：${data.members.active}条启用、${data.members.archived}条归档。常用词：${data.hot.map(item => `${item.title}（${item.recalls}次召回）`).join("、") || "尚未形成，正常聊天检索后逐步积累"}。`
    + (last ? ` 最近整理：${new Date(last.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}，知识合并${last.knowledgeMerged}条、归档${last.knowledgeArchived}条，成员归档${last.memberArchived}条、淡出${last.memberFaded}条。` : " 等待首次本机整理。")
    + (data.indexUnavailable ? " 召回索引暂不可读，原始记忆保留。" : "");
}
async function maintainMemory(prefix) {
  const data = prefix === "knowledge" ? knowledgeMaintenance : memberData.maintenance;
  if (!data) return;
  if (data.groupId !== (prefix === "knowledge" ? selectedKnowledgeGroup : selectedMemberGroup)) { showToast("正在切换群，请等本群记忆读取完成。", true); return; }
  if (!knowledgeForm.hidden || !memberForm.hidden) { showToast("请先保存或关闭正在编辑的记忆，再整理。", true); return; }
  const button = document.querySelector(`#maintain-${prefix}-memory`); button.disabled = true;
  try {
    const result = await requestAdminApi("/api/memory-maintenance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: data.groupId, revision: data.revision }) });
    showToast(result.message);
  } catch (error) { showToast(error.message, true); }
  finally { if (prefix === "knowledge") await loadKnowledge(); else await loadMemberImpressions(); }
}
document.querySelector("#maintain-knowledge-memory").addEventListener("click", () => void maintainMemory("knowledge"));
document.querySelector("#maintain-member-memory").addEventListener("click", () => void maintainMemory("member"));
function renderMemberList() {
  const list = document.querySelector("#member-list"), query = document.querySelector("#member-filter").value.trim().toLocaleLowerCase("zh-CN");
  list.replaceChildren();
  const members = memberData.members ?? [], candidates = members.reduce((sum, profile) => sum + profile.facts.filter(fact => !fact.archivedAt && fact.reviewStatus === "candidate").length, 0);
  document.querySelector("#member-count").textContent = `${members.length} 位成员 · ${members.reduce((sum, profile) => sum + profile.facts.filter(fact => fact.enabled).length, 0)} 条可用印象 · ${candidates} 条初步观察/待确认`;
  for (const profile of members.filter(profile => !query || `${profile.name} ${profile.userId}`.toLocaleLowerCase("zh-CN").includes(query))) {
    const button = document.createElement("button"); button.type = "button"; button.className = "command-card";
    const name = document.createElement("strong"); name.textContent = `QQ ${profile.userId}`;
    const detail = document.createElement("span"); detail.className = "field-hint";
    detail.textContent = `${profile.name ? "显示名：" + profile.name + " · " : ""}${profile.facts.filter(fact => fact.enabled).length} 条启用 · ${profile.facts.filter(fact => !fact.archivedAt && fact.reviewStatus === "candidate").length} 条待确认${profile.learningEnabled ? "" : " · 已暂停积累"}${profile.enabled ? "" : " · 已停用召回"}`;
    button.append(name, detail);
    for (const fact of [...profile.facts].filter(fact => !fact.archivedAt).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)) {
      const preview = document.createElement("span"); preview.className = "field-hint";
      preview.textContent = `${fact.supersededAt ? "已修正" : fact.stale ? "已淡出" : fact.enabled ? "已形成" : fact.reviewStatus === "rejected" ? "已拒绝" : "初步观察"} · ${fact.content} · ${fact.evidenceRefs?.length ?? 0}条支持`;
      button.append(preview);
    }
    if (profile.maintenance?.removed || profile.maintenance?.faded || profile.maintenance?.archived || profile.maintenance?.merged) {
      const maintenance = document.createElement("span"); maintenance.className = "field-hint";
      maintenance.textContent = `自动维护：合并${profile.maintenance.merged ?? 0}条重复、归档${profile.maintenance.archived ?? 0}条、淡出${profile.maintenance.faded ?? 0}条${profile.maintenance.removed ? `（旧版曾清理${profile.maintenance.removed}条）` : ""}`; button.append(maintenance);
    }
    button.addEventListener("click", () => editMember(profile)); list.append(button);
  }
  if (!list.children.length) { const empty = document.createElement("p"); empty.className = "field-hint"; empty.textContent = members.length ? "没有匹配的成员。" : "本群暂未形成成员印象。与AI正常聊话题或互动即可逐步积累，不需要说‘记住’；初步观察也会显示在这里。"; list.append(empty); }
}
function memberField(label, value, onChange, { area = false, maxLength = 240 } = {}) {
  const wrapper = document.createElement("label"); wrapper.className = "settings-field";
  const caption = document.createElement("span"); caption.textContent = label;
  const input = document.createElement(area ? "textarea" : "input"); input.value = value ?? ""; input.maxLength = maxLength;
  if (area) input.rows = 2;
  input.addEventListener("input", () => onChange(input.value)); wrapper.append(caption, input); return wrapper;
}
function renderMemberFacts() {
  const container = document.querySelector("#member-facts"); container.replaceChildren();
  for (const fact of memberDraft.facts) {
    if (fact.archivedAt && !document.querySelector("#member-show-archives").checked) continue;
    const card = document.createElement("article"); card.className = "member-fact";
    const status = document.createElement("p"); status.className = "field-hint";
    const evidence = fact.evidenceRefs ?? [];
    status.textContent = `${fact.archivedAt ? "已归档/可恢复" : fact.supersededAt ? "已被新偏好修正" : fact.stale ? "长期未获支持/已淡出" : { candidate: "初步观察/待确认", approved: fact.enabled ? "已形成/启用" : "已确认/停用", rejected: "已拒绝" }[fact.reviewStatus]} · ${fact.origin === "member" ? fact.basis === "dialogue" ? "日常对话逐步形成" : "成员自述" : "管理员维护"} · ${evidence.length} 条来源${evidence.length ? ` · 最近${new Date(evidence.at(-1).at).toLocaleString("zh-CN")}` : ""}${fact.supersedesId && !fact.enabled ? " · 修正候选，确认后停用旧版本" : ""}（修改需保存成员）`;
    const kind = document.createElement("select"); kind.setAttribute("aria-label", "印象类别");
    for (const [value, label] of Object.entries(memberKindNames)) kind.add(new Option(label, value)); kind.value = fact.kind; kind.addEventListener("change", () => { fact.kind = kind.value; });
    card.append(status, kind, memberField("主题", fact.topic, value => { fact.topic = value; }, { maxLength: 30 }),
      memberField("印象内容", fact.content, value => { fact.content = value; }, { area: true }),
      memberField("关键词（逗号或顿号分隔）", fact.tags.join("、"), value => { fact.tags = value.split(/[,，、]/u).map(tag => tag.trim()).filter(Boolean); }, { maxLength: 120 }));
    const actions = document.createElement("div"); actions.className = "form-actions";
    for (const [caption, action] of [[fact.archivedAt ? "恢复并确认" : "设为已确认", () => { fact.reviewStatus = "approved"; fact.enabled = true; fact.archivedAt = null; fact.stale = false; }], ["设为拒绝", () => { fact.reviewStatus = "rejected"; fact.enabled = false; }], ["停用", () => { fact.enabled = false; }], ["删除此条", () => { memberDraft.facts = memberDraft.facts.filter(item => item.id !== fact.id); }]]) {
      const button = document.createElement("button"); button.type = "button"; button.className = "button button-quiet"; button.textContent = caption;
      button.addEventListener("click", () => { action(); renderMemberFacts(); showToast("修改待保存，请点击‘保存成员’。"); }); actions.append(button);
    }
    if (evidence.length) { const source = document.createElement("details"), caption = document.createElement("summary"), refs = document.createElement("p"); caption.textContent = "查看来源指纹"; refs.className = "field-hint"; refs.textContent = evidence.map(ref => `${ref.hash.slice(0, 16)} · ${new Date(ref.at).toLocaleString("zh-CN")}`).join("\n"); source.append(caption, refs); card.append(source); }
    card.append(actions); container.append(card);
  }
}
function editMember(profile = null) {
  memberDraft = profile ? structuredClone(profile) : { userId: "", name: "", enabled: true, learningEnabled: true, facts: [] };
  document.querySelector("#member-editor-title").textContent = profile ? `成员 QQ ${profile.userId}` : "添加成员印象";
  document.querySelector("#member-user-id").value = memberDraft.userId; document.querySelector("#member-user-id").disabled = Boolean(profile);
  document.querySelector("#member-name").value = memberDraft.name;
  document.querySelector("#member-profile-enabled").checked = memberDraft.enabled;
  document.querySelector("#member-learning-enabled").checked = memberDraft.learningEnabled;
  document.querySelector("#forget-member").hidden = !profile;
  document.querySelector("#member-error").hidden = true; memberForm.hidden = false; renderMemberFacts();
}
document.querySelector("#member-show-archives").addEventListener("change", () => { if (memberDraft) renderMemberFacts(); });
async function loadMemberImpressions() {
  const sequence = ++memberLoadSequence;
  let data;
  try { data = await requestAdminApi(`/api/member-impressions${selectedMemberGroup ? `?groupId=${encodeURIComponent(selectedMemberGroup)}` : ""}`); }
  catch (error) {
    if (sequence !== memberLoadSequence) return;
    if (error.status !== 404 || !selectedMemberGroup) throw error;
    selectedMemberGroup = ""; data = await requestAdminApi("/api/member-impressions");
  }
  if (sequence !== memberLoadSequence) return;
  selectedMemberGroup = data.groupId ?? ""; memberData = data;
  renderMemoryMaintenance("member", data.maintenance);
  memberGroupSelect.replaceChildren(...data.groups.map(id => new Option(`群 ${id}`, id))); memberGroupSelect.value = selectedMemberGroup;
  document.querySelector("#add-member").disabled = !selectedMemberGroup; document.querySelector("#extract-member-impressions").disabled = !selectedMemberGroup;
  const learning = data.learning;
  const outcomes = { saved: "已保存或更新资料", "no-facts": "本次没有足够的新印象", "waiting-context": "等待与AI继续对话", waiting: "等待合并整理", learning: "正在整理对话", "model-error": "模型暂时失败，保留短期缓冲重试", "daily-limit": "知识提炼今日次数已用完", "buffer-cleared": "重启或关闭后已清空原始缓冲", filtered: "已过滤不适合积累的内容", "missing-key": "尚未配置模型密钥" };
  document.querySelector("#member-learning-status").textContent = selectedMemberGroup ? `群 ${selectedMemberGroup} · 待整理对话${learning?.bufferedMemberMessages ?? 0}条（共享缓冲${learning?.bufferedMessages ?? 0}条） · ${learning?.outcome === "daily-limit" ? "知识提炼达上限，成员对话积累仍可继续" : outcomes[learning?.outcome] ?? "等待与AI对话"} · 今日后台成员整理${learning?.memberAttemptsToday ?? 0}次，无每日次数上限${learning?.lastMemberSavedAt ? ` · 最近印象更新${new Date(learning.lastMemberSavedAt).toLocaleString("zh-CN")}` : ""}` : "请先在群与权限中添加授权群。";
  renderMemberList();
  if (!memberRefreshTimer) memberRefreshTimer = setInterval(() => { if (!managementContent.hidden && !document.querySelector("#page-members").hidden && memberForm.hidden) void loadMemberImpressions().catch(() => {}); }, 10000);
}
document.querySelector("#member-filter").addEventListener("input", renderMemberList);
memberGroupSelect.addEventListener("change", () => { selectedMemberGroup = memberGroupSelect.value; memberForm.hidden = true; void loadMemberImpressions().catch(error => showToast(error.message, true)); });
document.querySelector("#refresh-members").addEventListener("click", () => { memberForm.hidden = true; void loadMemberImpressions().catch(error => showToast(error.message, true)); });
document.querySelector("#add-member").addEventListener("click", () => editMember());
document.querySelector("#cancel-member").addEventListener("click", () => { memberForm.hidden = true; void loadMemberImpressions().catch(error => showToast(error.message, true)); });
document.querySelector("#add-member-fact").addEventListener("click", () => {
  if (memberDraft.facts.filter(fact => !fact.archivedAt).length >= 20) { showToast("每人最多20条当前印象，归档另存。", true); return; }
  memberDraft.facts.push({ id: crypto.randomUUID(), kind: "preference", topic: "", content: "", tags: [], reviewStatus: "approved", enabled: true }); renderMemberFacts();
});
memberForm.addEventListener("submit", async event => {
  event.preventDefault(); const groupId = selectedMemberGroup;
  memberDraft.userId = document.querySelector("#member-user-id").value.trim(); memberDraft.name = document.querySelector("#member-name").value.trim();
  memberDraft.enabled = document.querySelector("#member-profile-enabled").checked; memberDraft.learningEnabled = document.querySelector("#member-learning-enabled").checked;
  try {
    const data = await requestAdminApi("/api/member-impressions", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId, userId: memberDraft.userId, profile: memberDraft, revision: memberData.revision }) });
    if (groupId === selectedMemberGroup) { memberData = data; memberForm.hidden = true; renderMemberList(); } showToast(data.message);
  } catch (error) { document.querySelector("#member-error").textContent = error.message; document.querySelector("#member-error").hidden = false; }
});
document.querySelector("#forget-member").addEventListener("click", async () => {
  if (!window.confirm("清除此成员在本群的全部印象并暂停继续积累？旧印象不会自动恢复。")) return;
  const groupId = selectedMemberGroup;
  try { const data = await requestAdminApi("/api/member-impressions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId, userId: memberDraft.userId, revision: memberData.revision }) }); if (groupId === selectedMemberGroup) { memberData = data; memberForm.hidden = true; renderMemberList(); } showToast(data.message); }
  catch (error) { showToast(error.message, true); }
});
document.querySelector("#extract-member-impressions").addEventListener("click", async () => {
  try { const data = await requestAdminApi("/api/member-impressions/learn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: selectedMemberGroup }) }); showToast(data.message); }
  catch (error) { showToast(error.message, true); }
});

let visualData = { entries: [], revision: null }, visualScope;
let visualDraft = null, visualSequence = 0;
const visualForm = document.querySelector("#visual-form"), visualGroupSelect = document.querySelector("#visual-group");
const visualStatusLabels = { candidate: "待核实", confirmed: "已启用参考", disabled: "已停用", rejected: "已拒绝" };
function openVisualEditor(entry) {
  visualDraft = entry;
  document.querySelector("#visual-name").value = entry.name;
  document.querySelector("#visual-work").value = entry.work;
  document.querySelector("#visual-traits").value = entry.traits.join("\n");
  document.querySelector("#visual-entry-status").value = entry.status;
  visualForm.hidden = false; document.querySelector("#visual-name").focus();
}
async function mutateVisual(entry, remove = false) {
  const scope = visualScope, revision = visualData.revision;
  visualGroupSelect.disabled = true;
  try {
    const data = await requestAdminApi("/api/visual-memory", { method: remove ? "DELETE" : "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId: scope ?? "global", revision, entry }) });
    if (scope === visualScope) { visualData = data; visualForm.hidden = true; visualDraft = null; await loadVisualMemories(); }
    showToast(data.message);
  } catch (error) { if (error.status === 409) { visualForm.hidden = true; await loadVisualMemories(); } throw error; }
  finally { visualGroupSelect.disabled = false; }
}
function renderVisualMemories() {
  const list = document.querySelector("#visual-list"), query = document.querySelector("#visual-filter").value.toLocaleLowerCase("zh-CN");
  const status = document.querySelector("#visual-filter-status").value;
  list.replaceChildren();
  const entries = visualData.entries.filter(entry => (status === "all" || status === entry.status)
    && `${entry.name} ${entry.work} ${entry.traits.join(" ")}`.toLocaleLowerCase("zh-CN").includes(query));
  for (const entry of entries) {
    const card = document.createElement("article"); card.className = "command-card";
    if (/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/u.test(entry.preview ?? "")) {
      const image = document.createElement("img"); image.src = entry.preview; image.alt = "对应图片的低清预览"; image.width = 160; image.loading = "lazy"; card.append(image);
    }
    const title = document.createElement("h3"); title.textContent = `${entry.name} · ${entry.work || "作品待补充"}`;
    const info = document.createElement("p"); info.className = "field-hint"; info.textContent = `${visualStatusLabels[entry.status] ?? entry.status} · ${entry.origin === "web-verified" ? "联网核对后自动采用" : entry.status === "confirmed" ? "管理员标注（非官方核验）" : "群友提供的待核实说法"} · ${entry.groupId ? "仅本群" : "通用管理员参考"} · ${entry.evidenceRefs?.length ?? 0}条来源${entry.relatedStickerId ? " · 已关联库存表情" : ""}${entry.preview ? "" : " · 旧参考未保存预览"}`;
    const traits = document.createElement("p"); traits.textContent = entry.traits.join("；");
    card.append(title, info, traits);
    if (entry.verification) {
      const checks = { verified: "正文与参考画面核对通过", conflict: "资料或画面存在冲突", "existing-reference-conflict": "核对结果与已有同图标注冲突，未自动覆盖", "insufficient-sources": "可靠正文来源不足", "no-reference-image": "未取得可靠页面中的角色参考图", "insufficient-evidence": "姓名、作品或视觉证据不足", "search-disabled": "联网搜索已关闭", "search-unavailable": "搜索暂时不可用", "verification-unavailable": "核对未完成", cancelled: "核对已取消" };
      const details = document.createElement("details"), summary = document.createElement("summary");
      summary.textContent = "联网核对：" + (checks[entry.verification.status] ?? "待核实"); details.append(summary);
      for (const source of (entry.verification.sources ?? [])) {
        let url; try { url = new URL(source.url); if (url.protocol !== "https:" || url.username || url.password) continue; } catch { continue; }
        const row = document.createElement("p"), link = document.createElement("a"); link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = source.title || url.hostname; row.append(link);
        if (source.quote) row.append(document.createTextNode(" · 正文证据：" + source.quote)); details.append(row);
      }
      const time = document.createElement("p"); time.className = "field-hint"; time.textContent = "核对时间：" + new Date(entry.verification.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }); details.append(time); card.append(details);
    }
    if (entry.evidenceRefs?.length) {
      const details = document.createElement("details"), label = document.createElement("summary"), refs = document.createElement("p");
      label.textContent = "来源时间与指纹"; refs.className = "field-hint";
      refs.textContent = entry.evidenceRefs.map(ref => `${new Date(ref.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · ${ref.hash.slice(0, 16)}`).join("\n");
      details.append(label, refs); card.append(details);
    }
    const controls = document.createElement("div"); controls.className = "form-actions";
    const actions = [["编辑", () => openVisualEditor(entry)]];
    if (entry.status !== "confirmed") actions.push(["确认并启用", () => { if (!entry.work) { openVisualEditor(entry); showToast("请先补充作品名，再确认启用。", true); return; } return mutateVisual({ ...entry, status: "confirmed" }); }]);
    if (entry.status === "confirmed") actions.push(["停用", () => mutateVisual({ ...entry, status: "disabled" })]);
    if (entry.status === "candidate") actions.push(["拒绝", () => mutateVisual({ ...entry, status: "rejected" })]);
    actions.push(["删除", () => { if (confirm("删除这条角色视觉记忆？已有备份不受影响。")) return mutateVisual(entry, true); }]);
    for (const [label, action] of actions) {
      const button = document.createElement("button"); button.type = "button"; button.className = "button button-quiet"; button.textContent = label;
      button.addEventListener("click", async () => { button.disabled = true; try { await action(); } catch (error) { showToast(error.message, true); } finally { button.disabled = false; } }); controls.append(button);
    }
    card.append(controls); list.append(card);
  }
  if (!entries.length) { const empty = document.createElement("p"); empty.className = "field-hint"; empty.textContent = "暂无符合条件的角色记忆。群友附图纠正后，候选会显示在这里。已有旧角色样例可切换到通用管理员参考查看。"; list.append(empty); }
}
async function loadVisualMemories() {
  if (!visualForm.hidden) return;
  const sequence = ++visualSequence;
  try {
    const data = await requestAdminApi("/api/visual-memory" + (visualScope === undefined ? "" : `?groupId=${encodeURIComponent(visualScope ?? "global")}`));
    if (sequence !== visualSequence) return;
    visualScope = data.groupId; visualData = data;
    visualGroupSelect.replaceChildren(...[...data.groups.map(id => ({ value: id, text: `群 ${id}` })), { value: "global", text: "通用管理员参考（所有群）" }].map(item => { const option = document.createElement("option"); option.value = item.value; option.textContent = item.text; return option; }));
    visualGroupSelect.value = visualScope ?? "global";
    const learning = { waiting: "等待新的角色纠正", queued: "纠正处理已排队", extracting: "正在提取角色标注", verifying: "正在查维基百科、读取资料并核对画面", "web-verified": "证据核对通过，已自动采用", "candidate-saved": "已保留待核实候选，可查看不足或冲突原因", duplicate: "已有相同标注，未重复添加", "no-correction": "没有可保存的明确角色纠正", "ambiguous-image": "图片不唯一，未自动绑定，请单独发图纠正", "unavailable-or-rejected": "本次内容检查或提炼未完成，未保存图片；可重新明确纠正" };
    document.querySelector("#visual-status").textContent = `共${data.entries.length}条 · 待核实${data.entries.filter(entry => entry.status === "candidate").length}条 · 已启用${data.entries.filter(entry => entry.status === "confirmed").length}条 · ${learning[data.learning?.code] ?? "等待纠正"}${data.learningEnabled ? "" : " · 自动学习已关闭"}`;
    renderVisualMemories();
  } catch (error) { document.querySelector("#visual-status").textContent = error.message; }
}
visualGroupSelect.addEventListener("change", () => { visualScope = visualGroupSelect.value === "global" ? null : visualGroupSelect.value; visualForm.hidden = true; visualDraft = null; void loadVisualMemories(); });
document.querySelector("#refresh-visual").addEventListener("click", () => { visualForm.hidden = true; void loadVisualMemories(); });
document.querySelector("#visual-filter").addEventListener("input", renderVisualMemories);
document.querySelector("#visual-filter-status").addEventListener("change", renderVisualMemories);
document.querySelector("#cancel-visual").addEventListener("click", () => { visualForm.hidden = true; visualDraft = null; void loadVisualMemories(); });
visualForm.addEventListener("submit", async event => {
  event.preventDefault(); if (!visualDraft) return;
  const button = visualForm.querySelector("button[type=submit]"); button.disabled = true;
  try { await mutateVisual({ id: visualDraft.id, name: document.querySelector("#visual-name").value, work: document.querySelector("#visual-work").value,
    traits: document.querySelector("#visual-traits").value.split("\n").map(x => x.trim()).filter(Boolean), status: document.querySelector("#visual-entry-status").value }); }
  catch (error) { showToast(error.message, true); } finally { button.disabled = false; }
});
setInterval(() => { if (!managementContent.hidden && !document.querySelector("#page-visual").hidden && visualForm.hidden && !visualGroupSelect.disabled) void loadVisualMemories(); }, 10000);

function setupNavigation() {
  const descriptions = { members: "从与AI的日常对话中逐步了解每位成员，显示初步观察、已形成印象及自动维护。", chat: "管理通用功能、模型连接和默认人设；各群角色在分群人设中单独配置。", personas: "选择一个群，分别设置个性、表达风格、昵称呼唤词和长期记忆。", knowledge: "积累群内网梗和互动背景，查看、确认或编辑学到的知识。", stickers: "放入常用表情，给它们标上情绪和适用场景。", access: "查看连接状态，设置哪些群和好友可以与 bot 互动。", commands: "管理固定指令，常用回复一键配置。" };
  descriptions.visual = "管理角色纠正与核对来源；联网核对通过或管理员启用后，用于所在群的后续识图。";
  const buttons = [...document.querySelectorAll(".management-nav [data-page]")];
  function showPage(page) {
    if (!Object.hasOwn(descriptions, page)) page = "chat";
    for (const panel of document.querySelectorAll("[data-management-page]")) panel.hidden = panel.dataset.managementPage !== page;
    for (const button of buttons) { button.setAttribute("aria-selected", String(button.dataset.page === page)); button.tabIndex = button.dataset.page === page ? 0 : -1; }
    document.querySelector("#page-description").textContent = descriptions[page];
    document.querySelector("#add-command").hidden = page !== "commands";
    if (page === "members" && !managementContent.hidden && memberForm.hidden) void loadMemberImpressions().catch(error => showToast(error.message, true));
    if (page === "stickers" && !managementContent.hidden) void loadStickers();
    if (page === "knowledge" && !managementContent.hidden) void loadKnowledge();
    if (page === "visual" && !managementContent.hidden) void loadVisualMemories();
    if (page === "personas" && !managementContent.hidden) void loadGroupPersonas();
    history.replaceState(null, "", `#${page}`);
  }
  buttons.forEach((button, index) => {
    button.id = `tab-${button.dataset.page}`;
    button.setAttribute("aria-controls", `page-${button.dataset.page}`);
    document.querySelector(`#page-${button.dataset.page}`).setAttribute("aria-labelledby", button.id);
    button.addEventListener("click", () => showPage(button.dataset.page));
    button.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const next = buttons[(index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length]; showPage(next.dataset.page); next.focus(); });
  });
  window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
  showPage(location.hash.slice(1));
  document.querySelector("#knowledge-switches").prepend(llmFields.knowledgeEnabled.closest(".settings-field"));
  const grid = llmSettingsForm.querySelector(".settings-grid");
  const groups = [
    ["常用功能", true, ["nickname-trigger-enabled", "bot-aliases", "conversation-followup-enabled", "forward-reading-enabled", "search-enabled", "vision-enabled", "video-understanding-enabled", "proactive-chat-enabled"]],
    ["默认人设与私聊记忆", false, ["llm-personality", "llm-expression-style", "llm-memory", "llm-system-prompt"]],
    ["长回复发送", false, ["detailed-discussion-enabled", "long-reply-forward-enabled", "long-reply-threshold"]],
    ["联网阅读与总结", false, ["content-summary-enabled", "summary-output"]],
    ["模型连接与回复参数", false, ["llm-model", "llm-api-endpoint", "llm-api-key", "clear-llm-api-key", "llm-temperature", "llm-max-tokens", "model-retry-enabled", "refresh-model-diagnostics", "refresh-reply-recovery"]],
    ["联网搜索来源", false, ["search-provider", "serper-api-key", "clear-serper-api-key", "search-country", "search-language"]],
    ["图片与角色辨认", false, ["character-recognition-enabled"]],
    ["ChatGPT 网页生图", false, ["chatgpt-image-generation-enabled", "refresh-chatgpt-imagegen"]],
    ["B站视频理解", false, ["video-asr-enabled", "video-frames-enabled", "video-max-minutes"]],
    ["自主刷B站与群分享", false, ["video-discovery-enabled", "video-discovery-group-ids", "refresh-video-discovery"]],
    ["主动聊天频率", false, ["proactive-pause-when-ignored", "proactive-cooldown-minutes", "proactive-frequency-minutes", "proactive-debounce-seconds", "proactive-daily-limit"]],
  ].map(([title, open, ids]) => {
    const detail = document.createElement("details"); detail.className = "settings-group"; detail.open = open;
    const summary = document.createElement("summary"); summary.textContent = title;
    const content = document.createElement("div"); content.className = "settings-grid";
    for (const id of ids) content.append(document.getElementById(id).closest(".settings-field"));
    detail.append(summary, content); return detail;
  });
  grid.replaceWith(...groups);
  llmSettingsForm.addEventListener("invalid", (event) => { showPage("chat"); const detail = event.target.closest("details"); if (detail) detail.open = true; }, true);
}

document.querySelector("#refresh-model-diagnostics").addEventListener("click", async (event) => {
  const button = event.currentTarget, output = document.querySelector("#model-diagnostics"); button.disabled = true;
  try {
    const data = await requestAdminApi("/api/model-diagnostics");
    const labels = { start: "开始", http: "HTTP响应", transport: "连接失败", body: "正文传输", json: "数据解析", empty: "空回复", refusal: "模型拒绝", truncated: "长度截断", tools: "工具阶段", retry: "延迟补试", success: "返回答复", failure: "最终失败" };
    output.textContent = data.events.length ? data.events.slice(-20).map(item => `${new Date(item.at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}  ${item.id}  ${labels[item.kind] ?? item.kind}${item.code ? " · " + item.code : ""}${item.status ? " · HTTP " + item.status : ""}${item.route ? " · " + ({ proxy: "代理", proxy_ipv4: "代理 IPv4", model_proxy: "模型专用代理", model_proxy_ipv4: "模型专用代理 IPv4", direct: "直连" }[item.route] ?? item.route) : ""}${item.connection ? " · 连接池#" + item.connection + (item.reused ? " 复用" : " 新建") : ""}${item.phase ? " · " + item.phase : ""}${item.attempt ? " · 第" + item.attempt + "次连接" : ""}${item.elapsedMs !== undefined ? " · " + item.elapsedMs + "ms" : ""}`).join("\n") : "尚无新版诊断记录，收到模型请求后会出现。查看此页不会调用模型。";
  } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
});
document.querySelector("#refresh-video-discovery").addEventListener("click", async event => {
  const button = event.currentTarget, output = document.querySelector("#video-discovery-status"); button.disabled = true;
  try {
    const { status } = await requestAdminApi("/api/video-discovery");
    const labels = { SELECTING: "在为当前话题选片", READING: "在读视频内容", REVIEWING: "在核对与最新话题的关联", READY: "准备接话分享", SHARED: "已分享", NOT_INTERESTED: "这轮没挑到想看的", NOT_SHARING: "看过后决定不插话", NO_TOPIC_MATCH: "没有能自然接上话题的视频", TOPIC_CHANGED: "话题或发言时机已变化，取消本次分享", NO_NEW_CANDIDATE: "等待新视频", WAITING_DISCUSSION: "等待近期群聊话题", WAITING_MEMBER: "刚回复过，等待群友接话", WAITING_BOT_REPLY: "群友正等bot回答，先不插入视频", WAITING_GAP: "群友正在说话，等自然空隙", DISCUSSION_READY: "已有近期话题", VIDEO_OR_MODEL_UNAVAILABLE: "视频或模型暂不可用", BROWSER_UNAVAILABLE: "浏览器暂不可用", BILI_BROWSER_DISCONNECTED: "Edge 未连接", BILI_FEED_EMPTY: "首页未返回推荐视频", DELIVERY_UNCERTAIN: "发送状态待核对" };
    output.textContent = `${status.enabled ? "已开启" : "已关闭"} · 结合群聊自然分享 · ${status.active ? "正在浏览/阅读" : "当前空闲"} · 发送待核对 ${status.uncertain}\n` + (status.groups.length ? status.groups.map(group => `群 ${group.groupId}：已读 ${group.reviewed} · 已分享 ${group.shared} · ${labels[group.discussionCode] ?? "等待话题"}${group.lastCode ? "\n上次处理：" + (labels[group.lastCode] ?? group.lastCode) : ""}${group.quietUntil > Date.now() ? " · 无人回应，暂时安静" : ""}${group.lastTitle ? "\n最近分享：" + group.lastTitle : ""}`).join("\n") : "尚未指定授权群。输入群号并保存模型设置后生效。");
  } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
});

document.querySelector("#refresh-chatgpt-imagegen").addEventListener("click", async (event) => {
  const button = event.currentTarget, output = document.querySelector("#chatgpt-imagegen-status"); button.disabled = true;
  try { const { status } = await requestAdminApi("/api/chatgpt-imagegen");
    output.textContent = `Skill ${status.installed ? "已安装" : "未安装"} · 浏览器 ${status.connected ? "已连接" : "未连接"}\n排队 ${status.pending} · ${status.running ? "正在生成" : "当前空闲"} · 已生成待发送 ${status.generated} · 已发出 ${status.delivered}\n失败 ${status.failed} · 需核对 ${status.uncertain}`;
  } catch (error) { output.textContent = error.message; } finally { button.disabled = false; }
});

document.querySelector("#refresh-reply-recovery").addEventListener("click", async (event) => {
  const button = event.currentTarget, output = document.querySelector("#reply-recovery-status"); button.disabled = true;
  try { const { status } = await requestAdminApi("/api/reply-recovery"); output.textContent = `待补发 ${status.pending} · 重试中 ${status.running} · 已补发 ${status.delivered}（读回确认 ${status.verified}）\n状态待核对 ${status.uncertain} · 已到重试上限 ${status.exhausted} · 已取消 ${status.cancelled}`; }
  catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});
setupNavigation();
await initializeAuth();
