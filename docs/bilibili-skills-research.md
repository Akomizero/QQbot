# B站视频内容 Skill 调研

日期：2026-10-20（Asia/Shanghai）。本轮只调研，bot 目前仍是搜索视频元数据，尚未读取字幕、转写音频或分析视频画面。

后续进展：已安装 BiliLens 与 video-digest，并在 bot 接入字幕、本地语音转写及关键帧理解。实现及实际验证见 [更新记录](updates-20261020.md)；下文保留最初调研结论。

| 候选 | 文档列出的能力 | 对当前 bot 的适配 |
| --- | --- | --- |
| [bilibili-cli](https://github.com/public-clis/bilibili-cli/blob/main/SKILL.md) | 搜索、字幕/时间轴、B站 AI 摘要、音频提取供 ASR | 已安装 Skill 说明；CLI 可执行程序和 bot 内容解析工具尚未接入。适合先补字幕阅读。其文档说明字幕读取需要登录。 |
| [BiliLens / bilibili-video-parser](https://github.com/AntaresGG/BiliBiliVideoParser) | 优先人工/AI 字幕、可用字幕匿名提取、必要时本地 ASR，带时间戳的摘要 | 默认提取脚本仅依赖 Python 标准库，适合作为字幕解析参考；字幕可用性取决于视频及平台状态，登录态需另外授权配置。 |
| [video-digest-skill](https://github.com/coocA-Alex/video-digest-skill/blob/main/README.zh-CN.md) | 字幕、语音转写、FFmpeg 抽帧、视觉模型画面核验，可配置 OpenAI chat 等协议 | 更接近“理解视频画面”，但需要下载/抽帧、ASR 和视觉调用编排，运行成本更高。作者文档注明 Codex 包结构验证通过，provider 端到端执行仍待验证；本轮未实际运行。 |

建议先实现“给出 BV 号或视频链接 → 获取实际字幕 → 简短总结并标明来源”，无字幕时再考虑音频转写。需要理解梗视频动作和画面时，再加少量关键帧交给现有识图模型。仅有标题、简介或评论时，不应声称已经看过视频。安装 Skill 说明不会自动给当前 Node bot 添加运行能力，需要为其接入固定的、可控的解析工具。
