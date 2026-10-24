# 启动组件、健康判据与排查入口

**日期：** 2026-10-23（Asia/Shanghai）<br>
**阶段：** 本地实现与静态审阅，未执行本轮新启动器、未重启当前服务。

## 组件与职责

| 组件 | 入口 | 职责与就绪依据 | 常见未就绪状态 |
| --- | --- | --- | --- |
| 桌面/项目快捷方式 | `启动肥鱼.lnk`，由 `scripts/install-desktop-launcher.ps1` 安装 | 调用本项目启动脚本；快捷方式存在仅表示入口已安装 | 项目移动、脚本缺失、Node/依赖缺失 |
| 一键启动协调器 | `scripts/start-bot.ps1` | 检查本项目守护、管理端口、专用 NapCat/QQ 和健康快照；已有实例优先复用 | 端口被他程序占用、QQ登录未完成、健康快照缺失/过期 |
| 后台守护 | `scripts/run-bridge.ps1` | 维持本项目 bot 进程，退出后再启动，运行期间请求抑制自动休眠 | Node不可用、依赖缺失、启动持续失败 |
| bot 主进程 | `src/launcher.js` → `src/main.js` | 负责功能、管理服务和 OneBot 桥；需当前进程的新鲜健康信息确认各组件状态 | 管理服务或桥接初始化失败、旧进程尚未加载新代码 |
| 管理页 | 配置中的本机管理端口，入口 `/#access` | 页面监听归属于本项目进程，可以访问管理功能 | 仅页面可打开不能证明 QQ 或模型可用 |
| OneBot 桥 | 配置中的本机 WebSocket 端口和路径 | 主进程桥已监听，且token授权的本机WebSocket为OPEN；不能只凭任意TCP连接判定，不证明QQ登录或消息动作成功 | token/路径不匹配、客户端尚未连接；QQ登录须另行确认 |
| 专用 NapCat/QQ | 项目 `.local/napcat/OneKey` 中完整专用安装 | 使用现有 `.local/napcat/bot-workdir` 配置；进程存在仅是启动线索，登录与收发不能由健康快照证明 | 缺少组件、登录失效、专用QQ卡住 |
| 外部模型/搜索/生图等能力 | 既有配置与各自调用入口 | 启动阶段不主动花费额度验证，须由实际授权调用结果判断 | 网络、凭据、额度或服务故障；不等于 bot 本身未启动 |

## 健康信息与判定边界

管理页就绪、OneBot连接就绪、上游工具可用是不同层次。启动器应分别呈现，不把管理端口监听或专用QQ进程存在当作全部服务已恢复。

主进程写入 `.local/bot-health.json`，`version: 1`，每5秒及生命周期/OneBot状态变化时刷新，退出清理计时器并写入 `stopped`。启动器要求快照PID对应当前本项目worker、版本匹配且更新时间距现在不超过20秒。旧进程没有快照、退出后遗留快照、过期快照均不能证明当前实例已加载本轮功能。源码已经修改不等于内存中的旧进程已激活新版。

| 字段 | 含义与使用边界 |
| --- | --- |
| `pid`、`updatedAt` | 进程标识及毫秒时间戳，用于与当前worker核对和判断新鲜度 |
| `state` | `starting`、`waiting-qq`、`ready`、`degraded`、`stopped`，区分启动中、等QQ、核心就绪、异常与停止 |
| `startupComplete` | 必需初始化调用是否完成，不代表外部服务已实际调用成功 |
| `coreReady` | 必需初始化完成、管理server正在监听且桥连接就绪；不证明模型/搜索/浏览器可用 |
| `onebot.connected`、`onebot.port` | 主进程观察到token授权的本机WebSocket是否OPEN与配置端口；不证明QQ登录或OneBot消息动作成功 |
| `components` | 组件 `id`、`label`、`required`、`state` 和可选 `detail`，按组件展示证据层级 |

`replyRecovery`、`memoryMaintenance`、`videoDiscovery` 的 `started-unverified` 只证明启动调用完成，没有证明任务执行了一轮；主动聊天为消息事件驱动，不据此虚构独立启动定时器。外部能力最多标为 `configured-unverified`、`disabled` 或 `missing-dependency`，启动阶段不做网络探测或消耗调用额度。

`state: degraded` 可与 `coreReady: true` 同时出现，例如某可选能力缺少本地依赖；启动器以当前PID、新鲜快照与 `coreReady` 判核心初始化，不能仅凭总状态字符串判全部失败或全部成功。`startupComplete` 对应初始化代码已走到完成位置，不等同任务循环或外部服务通过验收。正常退出写 `stopped`，硬杀或断电可能来不及写，必须核对PID与时效。

### 组件ID与证据层级

| 范围 | ID | 可确认的内容 |
| --- | --- | --- |
| 必需组件 | `configuration`、`onebot`、`management` | 启动预检、桥接连接状态、管理server监听的本机局部证据 |
| 必需调度入口 | `replyRecovery`、`memoryMaintenance` | `started-unverified` 只表示启动函数返回，未证明一轮补发或维护成功 |
| 可选入口/出口 | `videoDiscovery`、`stickerDescriptions`、`modelProxy` | 前两项有 `activation: started-unverified`，实际state按开关/已知依赖列出；模型出口只记录初始化/配置，不探测当前连通性 |
| 模型、搜索与图片 | `model`、`search`、`vision`、`characterRecognition` | 配置/开关及已知依赖，不调用上游模型或搜索验证 |
| 学习与接话入口 | `visualLearning`、`knowledgeLearning`、`memberLearning`、`stickerLearning`、`proactive` | 事件驱动入口的配置状态，不证明已有学习记录或主动聊天任务 |
| 视频与网页生图 | `videoUnderstanding`、`videoAsr`、`videoFrames`、`chatgptImages`、`browserSession` | ASR、ffmpeg、生图helper只检查固定文件是否存在，不执行；浏览器不探测登录/连接 |

上述能力快照为当前配置的本机视图，不是逐群实际调用清单。快照不包含密钥、群号、成员账号、消息或人设内容。

## 排查顺序

1. 先看 `.local/one-click-start.log`，区分入口/依赖错误、管理页问题、QQ/OneBot未连接与健康版本问题。不要输出配置全文或密钥。
2. 检查 `.local/bridge-supervisor.log`、`.local/bridge-managed.stderr.log`；确认是本项目入口与端口，端口被其他程序占用时保留其他进程。
3. 管理页能打开而 QQ 未连接：查看 `/#access` 和专用QQ登录界面，先完成登录；不能仅凭页面可打开宣布能收发群消息。
4. 专用QQ存在但未接入：先查看登录和桥接配置；只在用户显式选择修复后操作本项目专用QQ，绝不结束其他目录的QQ或按进程名批量结束所有QQ。
5. 健康快照缺失、过期或版本不匹配：显示尚不能确认新功能就绪，保留当前服务；不要自动重启以掩盖版本差异。
6. bot 与 OneBot已就绪，但模型/搜索报错：按诊断号和对应日志处理上游调用，不能靠反复启动QQ解决所有故障。

启动协调器参数为 `-NoBrowser`（不开管理页）和 `-RepairDedicatedQQ`（显式请求修复专用QQ）。常规断连提示重试/取消，用户取消不动QQ；已有真实OneBot连接不执行修复。管理页最多等待45秒，随后真实OneBot/健康状态最多30秒；显式修复后再等最多30秒，不无限等待。命令示例见[一键启动](one-click-start-20261023.md)。

源码静态对照已确认 `src/service-health.js` 的字段/组件定义与 `src/main.js` 生命周期标记，以及启动脚本的版本、PID、新鲜度和分层判断入口；未执行这些入口。最终语法/静态检查结果由统筹集成汇总，不把启动调用完成等同运行验收通过。

## 待验收表

| 场景 | 合格标准 | 本轮运行验收 |
| --- | --- | --- |
| 首次双击/已有实例/连续双击 | 启动缺少的本项目组件，复用已有实例，不重复或重启bot | 未执行 |
| 管理页可开但QQ未连接 | 明确提示管理服务与OneBot状态不同，不误报整体成功 | 未执行 |
| 新版主进程健康快照 | 验证当前PID、版本、时效和分组件状态，不接纳旧快照 | 未执行 |
| 旧主进程无快照 | 提示新版未加载，保留运行实例，不声称新功能已激活 | 未执行 |
| 专用QQ登录失效/组件缺失 | 提示具体处理入口，不影响其他QQ | 未执行 |
| 用户显式修复专用QQ | 仅处理本项目专用QQ，其他安装及bot实例保留 | 未执行 |
| 管理端口被其他程序占用 | 提示端口冲突，不强制结束其他进程 | 未执行 |
| 关闭管理网页 | bot后台继续运行，不将关网页等同停服务 | 未执行 |
| 真正系统休眠/关机 | 明确本机无法继续工作，不承诺离线运行 | 未执行 |

本轮不运行/新增测试、不发群消息、不启动或重启当前服务、不发布；首次实际执行新启动器及分组件验收仍待后续授权窗口。
