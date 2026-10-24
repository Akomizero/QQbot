# 角色识别独立审查（2026-10-24）

用户反馈持续误判角色，并要求继续完成既有工作。本对话负责等待项目经理实现、审阅反馈与独立复测；不能将派发当作完成。

## 修复前基线

实际调用生产 `understandImageCharacters`，使用合成纯色PNG与模型替身，不发送真实QQ消息或外部模型请求：

1. 替身返回虚构姓名/作品、high，证据仅“蓝色头发”“蓝色眼睛”。实际输出仍为high且inspectionCompleted=true。证明解析门槛仅检查两条文本数量，不能判断证据是否有区分度。这不代表真实模型对纯色图做出该识别。
2. 输入两张图，替身返回两个index=1并遗漏index=2。实际输出索引[1,1]且inspectionCompleted=true。证明缺少完整性与唯一性校验。
3. 静态发现首轮识别hints包含最近20条referenceCharacters，不要求与当前图片匹配。可能使独立识别被库中角色名带偏，属于待实证的风险，尚不能断言是用户某次误判的原因。

已将以上证据交项目经理，并要求覆盖普通贴图、显式问身份、相似角色、临时标注、冲突标注、多图及最终回复不提升置信度。已向用户询问具体误认角色或时间，继续自主核查现有记录。

## 待验收

- 项目经理的定稿源码、测试和真实读图样本结果。
- 无关记忆不参与首轮识别；unknown/possible不会在最终回复变为确定姓名。
- 保留同图临时纠正与原有群隔离，不以关闭识图或关闭记忆代替修复。
- 样本须有明确标签，模型自猜不能作为真值；模拟结果不能冒充识别准确率。
- UI-S01～S05前端简化继续完成并交验。

## 第一版修复退回

对新 `guardCharacterReply` 独立调用：空blockedNames、happy反应时，“这是两个人在拥抱，挺温暖的。”被误拦成固定笑脸话术；“画面里的派蒙正抱着朋友。”却被放行。已要求修复普通描述误伤和未知名字绕过，未验收该版。

## 首批真实样本审阅

审阅 `.local/character-real-20261024-BV9F01/report.json`：2次真实模型请求，仅两个用户标注图，官方对照图下载失败。一张用户标注“达妮娅”的图片在旧有名字提示下答同名，新盲识猜“爱莉希雅”后被判unknown；自定义Claude图未知。此轮证明程序减少确定断言，不证明识别准确率提高，也不构成官方真值成功样本。已要求继续补公开可核对标签，并分别报告模型猜测正确性、候选/弃答和普通画面理解。

用户补充“基本都乱认了”，本轮按整体可靠性排查，不再要求提供单个案例才能推进。

## 中断后继续审查

项目经理上一轮因额度限制失败中断；用户要求继续后，已发送恢复指令并确认线程重新处于执行状态。

- 独立执行当前 `node test/character-reliability.mjs`，13/13 通过，证据 `.local/character-reliability-EQ4XT3/report.json`。这是隔离环境、模拟模型与生产调用链测试，不是实图准确率。
- 最新已有真实报告 `character-real-20261024-zhMxop/report.json` 中，皮卡丘和皮丘恢复为正确视觉识别；用户标注达妮娅仍 unknown。两次盲看一致不能视为来源核实，且该报告 baseline 为 null，已要求说明比较基准。
- 当前普通聊天的名字审核会无条件替换全部角色/作品名，可能误伤有依据的称呼，已返修。
- `llm.js` 早期身份模板排除了查证/详细资料类请求，但末尾仍无条件覆盖身份请求，可能丢弃复合问题的详细回答，已要求修复和生产链路回归。

状态：尚未验收。继续等待项目经理完成角色识别与 UI-S01–S05，再审阅、复测和核对运行版本。

### 恢复后的已有功能回归

- `node --test test/privacy-boundary.mjs test/imagegen-runtime.mjs test/sticker-variety.mjs`：30/30。
- `node test/image-exchange-replay.mjs`：16 场景通过，证据 `.local/image-exchange-replay-dkOZ5o/report.json`。
- `node test/memory-privacy-impact.mjs`：13/13，证据 `.local/memory-impact-xljIZs/report.json`。

均为隔离回归；未发送真实 QQ 消息，不能替代真实读图准确率和新前端的最终验收。

## 定稿复测（等待项目经理最终交付）

- 角色链路 `character-reliability`：19/19，`.local/character-reliability-CQu5dV/report.json`。包含多图同名按出现位置处理、复合提问不被模板覆盖、转发图片唯一编号和旧图引用。
- 前端简化 `ui-simplification`：11/11，`.local/ui-simplification-2U7XVR/report.json`。包含共享任务、防重、群切换、记忆维护及旧时间/骰子/echo 行为。页面函数测试及源码检查不能等同于桌面实机全操作验收。
- 临时视觉标注 `visual-memory-provisional-vision`：11/11，`.local/visual-provisional-vision-MJU1xu/report.json`。
- 真实模型结果独立回放：`.local/character-real-replay-MpnoXn/report.json`。回放来源为 `.local/character-real-20261024-lpg64D/report.json` 的已保存真实响应，本次没有追加真实模型调用。官方四张单图和一张双角色图结果正确；两个用户标签样本均 unknown。原始真实响应仍包含将用户标注达妮娅猜成爱莉希雅的错误，最终程序因复看不支持而弃答，不能据此声称模型本身认对或总体准确率提高。
- 已独立核对 0.2.10 构建与安装 EXE 的 SHA256 均为 `3DCFCBFF294241BA68D1E98E2B8D958A97D49B7FE9C7FC152DFA72008B30499A`。已安装不代表旧窗口已换版。
- 本对话浏览器连接检查超时；未重启共享浏览器。已查看项目经理提供的页面截图，页面交互结果另以其交付证据为准。

尚待：完整 P0 计数断言核对、最终源码加载及连接状态、项目经理最终反馈。
