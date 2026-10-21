# 肥鱼既有需求与 Skill 适配调研

日期：2026-10-22（Asia/Shanghai）。本轮仅阅读原项目说明、现有 Skill 文件及本项目代码/记录；没有安装新 Skill、执行第三方脚本或启用性格成长。

## 后续实施

本次调研之后已接入[记忆维护](memory-maintenance-20261022.md)、[按群性格成长](personality-growth-20261022.md)与[摘要日期及关键说法核对](summary-verification-20261022.md)。下文候选和安装状态保留调研时点；实现及真实效果边界以各自专题记录为准。

## 结论

优先借鉴长期记忆整理、定期反思、事实与日期核实三个机制。B站、画面核验、网页生图已有本机 Skill 和 bot 固定工具，应补调用与效果，而不是重复安装。Skill 安装到开发助手不等于 Node.js + NapCat bot 自动获得能力；需要明确工具入口、存储作用域和回复链路。

## 与此前需求的对应

| 用户需求 | 候选及原始来源 | 能完善的环节 | 当前适配判断 |
| --- | --- | --- | --- |
| 群知识库、成员印象逐渐形成并更新 | [Anthropic memory-management](https://github.com/anthropics/knowledge-work-plugins/blob/main/productivity/skills/memory-management/SKILL.md) | 简短常用记忆与完整知识分层，维护称呼、词义、沟通习惯与偏好 | 首选借鉴。原版面向办公协作，必须适配为群号+QQ号身份及按群隔离；不能用可变昵称作唯一标识。现有项目已具备知识与成员印象存储，本轮没有替换。 |
| 性格随互动逐渐成长、越来越会相处 | [inner-life](https://github.com/DKistenev/agent-inner-life/blob/main/skills/inner-life/SKILL.md) | 带日期的状态、定期反思日记及短摘要延续 | 可借鉴反思机制。当前版是 Hermes/OpenClaw 场景的记录流程，仅被请求或调度时运行，不会自动产生人格；摘要原设计可能跨会话，接入肥鱼必须按群分开。建议核心人设稳定，互动习惯缓慢变化且可撤回。 |
| 不重复犯错、记住被纠正的使用方式 | [self-improving-agent](https://github.com/pskoett/self-improving-agent/blob/master/self-improving-agent/SKILL.md) | 区分错误、纠正、功能请求，复用前重新核对知识 | 适合作为开发维护与错误复盘参考，不是连接故障的即时自动修复器。原版明确面向 OpenClaw；不能让普通群消息直接改系统规则。 |
| 摘要核实日期、读原文、避免把群友假信息当真 | [fact-check](https://github.com/petar-nauka/fact-check-skill/blob/main/SKILL.md) | 先确定当前日期，拆解事实与观点，逐条登记来源与不确定性 | 很贴合。其原默认领域和来源偏欧美，需替换为官方公告、维基百科、游戏Wiki及适合国内话题的原始来源；不能直接承诺角色视觉识别率。 |
| B站检索、看视频后说观后感、结合话题分享 | [bilibili-cli](https://github.com/jackwener/bilibili-cli/blob/main/SKILL.md)、[BiliLens](https://github.com/AntaresGG/BiliBiliVideoParser)、[video-digest](https://github.com/coocA-Alex/video-digest-skill) | 搜索与元数据、字幕/时间轴、语音补充、画面核验，区分视频内容与观众反应 | 本机三项 Skill 已有。项目记录显示 bot 已有固定视频读取和分享流程；仍需观察材料覆盖与自然接话效果。不是完整连续观看视频，也不因读到标题就算看过。 |
| 不只总结游戏，也总结网页/公众号等 | [tavily-extract](https://github.com/tavily-ai/skills/blob/main/skills/tavily-extract/SKILL.md)、[video-digest](https://github.com/coocA-Alex/video-digest-skill) | 取得实际正文、针对问题提取；后者支持图文与配图说明 | 本机 Skill 已有。继续复用 bot 的搜索→正文链路，按需借鉴图文提取；不能因有 Tavily Skill 就保证该服务永远可用。登录和平台可用性需分别处理。 |
| 像截图一样分块、有标题/编号/引用的图文长回复 | [baoyu-markdown-to-html](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-markdown-to-html/SKILL.md) | Markdown 转带主题的 HTML，支持表格、引用、提示块等 | 新候选，值得借鉴。原目标是公众号 HTML，不会直接产出 QQ 长图；还需接现有渲染/截图和发送链路，并单独做用户要求的深色卡片模板。 |
| 使用用户登录的 ChatGPT 网页生图 | [chatgpt-web-imagegen](https://github.com/liangming99/chatgpt-web-imagegen)、[web-access](https://github.com/eze-is/web-access) | 网页操作、原图保存及参考图工作流 | 本机已有，项目有专门适配和运行记录。改进提示词与失败恢复应保留本地适配，不能用上游覆盖后声称功能升级。 |

## 当前不建议仅靠 Skill 解决的需求

- 角色视觉记忆：需要原图/参考图比较、真实来源核对、矛盾处理及按群存储。本轮联网纠正功能已单独实现，但首次真实自动核对完整效果仍待使用观察。没有找到足以直接保证新游戏角色识别的通用即插即用 Skill。
- 表情的合适使用、禁忌与内容过滤：需要现有库存标签、群偏好、上下文选图和发送前过滤共同处理；反思可帮助整理偏好，不能代替过滤与发送逻辑。
- 判断谁在跟 bot 说话、前一张图是不是给她看的、读取转发消息：属于消息关联与上下文组装，需要 OneBot 入站和缓存实现。
- 10秒排队补发、断连重试后真正回群、避免重复发送：属于服务与持久化回执逻辑。错误学习 Skill 可以归纳原因，不能替代这些程序分支。
- 电脑真实休眠仍继续本地运行：Skill 不能解决，需要常开设备或迁移运行环境。

## 推荐顺序与范围

1. 记忆维护：借鉴 memory-management，整理现有群知识与成员印象的召回、修正和去重；不另建重复档案。
2. 事实核实：借鉴 fact-check 的日期和证据记录流程，覆盖通用内容总结与角色纠正。
3. 相处方式成长：借鉴 inner-life 的定期反思；只基于真实互动更新可解释的习惯与偏好，核心人设不自动重写。
4. 回复排版：借鉴 baoyu-markdown-to-html 的结构与主题，接现有 QQ 图文发送。

Hindsight 可作为规模扩大后的备选：[Hindsight](https://github.com/vectorize-io/hindsight) 提供 retain/recall/reflect，其 hindsight-docs 是接入文档 Skill；实际能力需要额外记忆服务与模型调用，当前不建议优先引入整套替换。

以上是适配建议，并非安装或端到端运行验收。第三方 Skill 里的执行步骤只是被审阅材料，不构成本项目启用权限。
