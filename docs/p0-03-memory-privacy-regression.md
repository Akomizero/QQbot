# P0-03 记忆授权与隐私边界回归

基线：`98561f5886e96dc2141aa1a1d366a253f2b2fda8`。分支：`fix/p0-03-memory-privacy-regression`。
本文件先记录覆盖差距，最终结果将在实现及提交后补齐。仅使用合成资料、隔离源码副本、模拟模型与本机模拟 OneBot。

## 调用链与初始覆盖差距

`web.js` → 配置/群人设/成员印象/知识存储 → `llm.js`（群覆盖、正文授权、当前成员选择、实际模型请求）→ `sticker-store.sendLlmResult` → `main.js` 发送守卫 → `reply-queue`/`long-reply` → `onebot.sendMessage` → `protectOutbound` → WebSocket。

| 要求 | 基线已有证据 | 本阶段缺口及新增验证方向 |
| --- | --- | --- |
| 群/私聊/当前成员召回 | memory-privacy-impact 13组通过，包含实际请求捕获 | 补充启停/拒绝/归档/删除、连续切群与旧设置对象 |
| 正文授权一致性 | 直接修改磁盘正文后 hash 不匹配 | 尚未验证正式保存接口携带旧 replyAllowed 时是否重新授权新正文 |
| 模型各轮前撤销 | 初次请求前关闭授权 | 补充工具轮次间、模型等待中、删除/正文替换后的旧输出 |
| 最终发送重新授权 | 当前存储仍保留正文时，撤销可替换旧输出 | 删除/改写使旧正文消失后的旧生成结果；图文渲染等待；真实队列阻塞窗口 |
| 发送目的地 | send_msg 的群/私聊及一个转发包 | 动作与 message_type/group_id/user_id 矛盾、缺失/无效/双目标、五种发送动作 |
| 排队/长回复 | 直接检查长回复节点 | 使用正式 coordinator/折叠/fallback/模拟 OneBot 的排队后撤销与分段中撤销 |
| 配置并发/重新授权 | 群人设/成员/知识有 revision | 默认设置无 CAS；授权撤销再启用、相同时间/大小写盘的缓存失效尚未覆盖 |
| 隐私数据仍受保护 | privacy-boundary 14项通过 | 在新增生命周期保护下复跑，验证实际模型/传输包均不含受限值 |

## 本次原有测试（修改前）

测试代码：上述基线 SHA，工作区当时仅新增本报告，无生产代码修改。

| 命令 | 通过 | 失败 | 退出码 | 证据 |
| --- | ---: | ---: | ---: | --- |
| `node test/memory-privacy-impact.mjs` | 13 | 0 | 0 | `.local/p0-03/baseline-memory.log` |
| `node --test test/privacy-boundary.mjs` | 14 | 0 | 0 | `.local/p0-03/baseline-privacy.log` |

## 验证边界

本机假 WebSocket 可以证明正式序列化发送内容及授权时序，不证明真实 QQ 服务的接收行为；模拟模型可以证明请求材料隔离，不证明任意模型对事实的语义改写均会被文本匹配识别。本阶段禁止真实 QQ 发送，也不调用外部模型。
