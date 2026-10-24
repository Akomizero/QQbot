# 功能验证报告（2026-10-23 05:00）

## 结论

整套链路是在线的，不是空壳：桌面壳 0.2.3 → Node 服务 → NapCat → QQ 全部连通，并且**正在实时回复群消息**（05:00:08 一次模型调用成功，05:00:33 又发起一次）。

项目自带隔离测试 **107 通过 / 1 失败**，失败项是测试期望过期，不是功能坏了（见文末「发现的问题」）。

## 运行时证据

| 项 | 实测值 |
| --- | --- |
| 桌面程序 | `Feiyu.exe` pid 126040，`desktop-ui-status.json` → `version 0.2.3 / phase ready / ownedCount 8` |
| 服务进程 | pid 125732，`bot-health.json` → `state ready / startupComplete true / coreReady true` |
| OneBot | `connected true, port 16700`，`127.0.0.1:14029 ↔ 16700` ESTABLISHED |
| 实时流量 | 模型诊断 04:56:16 success、05:00:08 success、05:00:33 start |

## 功能逐项

| 功能 | 状态 | 依据 |
| --- | --- | --- |
| 群/私聊接入与白名单 | ✅ 可用 | access-control：群 2 / 私聊 1 |
| 指令系统 | ✅ 可用 | commands：5 条 |
| 自然语言回复（模型链路） | ✅ 可用 | 实时调用 + 三次人设冒烟全通 |
| 分群人设 | ✅ 可用 | 游戏群/宿舍群各自生效，`groupPersonaRevision` 随消息下发 |
| 本地知识库 | ✅ 可用 | `searchKnowledge("肥鱼")` 命中 2 条 |
| 群聊知识积累 | ⚪ 已实现未触发 | 结构可读，候选 0 / 已学 0（需真实对话触发） |
| 成员长期印象 | ✅ 可用 | 9 位成员；饲养员上下文长度 237 |
| 表情包库 | ✅ 可用 | 31 张 + 本群使用偏好规则 |
| 角色视觉记忆 | ⚪ 已实现无数据 | 本群 entries 0；可用参考 1（全局「达妮娅」基线） |
| 性格成长 | ⚪ 已重置 | generation 0、习惯 0、baseline 不匹配（今天改人设导致，属预期） |
| 记忆维护调度 | ✅ 可用 | `memoryMaintenanceSummary` 返回完整 revision + 知识统计 |
| 视频话题发现 | ✅ 配置就绪 | enabled / active false（群聊沉默时才触发） |
| 失败回复恢复 | ✅ 可用 | delivered 4 / verified 4 / pending 0 |
| 模型诊断 | ✅ 可用 | 80 条环形记录，无明文提示词 |
| 管理面板 | ✅ 接线完整 | 8 个页面 / 19 个 `/api/*` 路由全部返回 401（非 404），鉴权生效 |
| 桌面壳 | ✅ 可用 | 0.2.3 已安装并运行，管着 8 个子进程 |

## 依赖就绪度

- `ffmpeg-static` → 已安装（`node_modules/ffmpeg-static/ffmpeg.exe`）
- 视频本地语音转写 → `.local/video-asr-model` 已存在
- 搜索 → `SERPER_API_KEY`(40) / `TAVILY_API_KEY`(58) 均已配置
- 生图 → `.local/chatgpt-images` 目录存在

## 未验证项（缺条件，不是缺功能）

| 项 | 缺什么 |
| --- | --- |
| ChatGPT 网页生图 | 需要已登录的浏览器会话，无法在无头环境确认登录态 |
| B 站视频理解 | 需要一条真实视频跑完取字幕+抽帧+ASR 全流程 |
| 网页搜索实际返回 | 会真实消耗配额，未在验证中触发 |
| 主动接话 | 需要群聊静默一段时间才会触发，未观测到 |
| 二维码页面 | 当前已登录，`qrDisplayed=false`，无法回放扫码页 |

## 发现的问题

### 1. 唯一失败用例：`unresolved tool response is classified`（测试期望过期）

测试断言"模型一直要调用不存在的工具时，应该发 2 次请求就报 `TOOLS_UNFINISHED`"，实际发了 **5 次**。

复现（`.local/probe-tools-loop.mjs`）后请求序列是：

```
#1 tools=[search_meme_knowledge]  msgs=8   → 模型要调 unknown tool
#2 tools=[search_meme_knowledge]  msgs=10  → 工具循环第 2 轮
#3 tools=[search_meme_knowledge]  msgs=12  → 工具循环第 3 轮
#4 tools=[]                       msgs=15  → 强制收尾（"请停止调用工具"）
#5 tools=[]                       msgs=16  → 空回复补试
→ TOOLS_UNFINISHED
```

原因：`llm.js` 的工具循环最多 3 轮（每轮把"此工具不可用"回给模型），循环结束后还有一次强制收尾请求，收尾仍然 `tool_calls` 时又走一次补试。测试写于只有单次补试的年代，断言没跟着更新。

**功能没坏**，错误最终归类正确，只是**代价偏高**：模型一旦抽风调不存在的工具，会连发 5 次请求（每次 5–10 秒），用户要等 30–50 秒才收到"工具处理未能完成"。

- 处理建议 A（推荐）：`unknown_tool` 不参与多轮，第一次就把"此工具不可用"回给模型并直接进入收尾，请求数从 5 降到 2；同时把测试断言改成 2。
- 处理建议 B：只更新测试断言为 5，保留现状。
- 我倾向 A，但这会改变真实回复路径的行为，需要你点头再动。

### 2. 无其他问题

`/api/*` 全部正确返回 401，没有 404 或 500，说明路由与鉴权都没漏接。数据文件结构全部可解析，没有损坏。
