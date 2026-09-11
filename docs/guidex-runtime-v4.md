# GuideX Runtime v4 适配与指标说明

新版适配分支为 `codex/guidex-v4-runtime`，旧版发布分支为 `main`。本分支在插件弹窗中提供自动识别（`Auto`）、新版（`Runtime v4`）和旧版（`Legacy`）三种选择。

加载插件不需要构建，也不需要安装依赖。新版业务指标使用独立的探针和字段定义，不改变旧版历史数据的含义。

## 字段定版与历史清理

**当前状态：未定版，等待用户明确确认最终字段。**

- 定版前，每次字段设计调整后清理失效的 Runtime v4 测试历史，只保留当前设计；不维护本适配开发期间的旧字段别名或历史节点推算。
- 清理范围仅为已核实目标环境中 `ext_guidex-runtime-v4` 的交互结果及对应汇总，保留任务和探针注册。Legacy `guidex-interaction`、WebRTC 和其他任务的数据不受影响。
- 这是字段迭代时的受控清理，不是定时任务，也不能在服务启动、插件加载或每次上报时自动删除。执行前核对目标、记录数量和汇总，执行后验证范围及剩余数据。
- 用户明确确认定版后，同步将本节及两个仓库的协作说明标记为“已定版”；此后不得再以适配或字段升级为由清理历史，应采用版本标记、迁移或兼容方案。平台既有数据保留期限属于另一项策略，本规则不修改它。
- 更新字段后须重新加载插件和 GuideX 页面再采样；正在运行的旧注入脚本或其待重试队列仍可能上报旧格式，单纯清库不会更新客户端。

2026-09-10 已按用户要求清理 yghk 上该任务的 9 条历史结果；清理后原始记录和 `agg_1m/agg_10m/agg_1h/agg_8h` 均为 0，其他任务记录及注册信息保留。此次未重启或替换远端服务。

2026-09-10 08:31 UTC 核对 1.1.2 字段调整时，另有 1 条旧格式测试记录（含 `start/mic_request/mic/ready`，无 `mic_ready`）。已按确切任务及记录 ID 在事务内清理；清理后该任务原始记录和四级汇总均为 0，其他 74,277 条结果、7 个任务、4 个探针及 Agent 注册经计数和内容摘要核验未变。本次仅更新本地代码/文档及受控清理，尚未部署新前后端、重载插件或 GuideX 页面，也未完成新版真实交互验收。

## 适配依据

### 当前源码 1.1.5（yghk 前后端已部署，用户反馈 Chrome 已重载）

确认正常离场时将待收尾轮次记为 `success=true, completion_reason=session_ended`，不新增展示字段。原始明细和导出保留，ProbeX 趋势图在后端聚合前排除这些记录，底部单轮选择器也排除；不以浏览器聚合桶的成功标记反推单条结果状态。Excel 改用独立原始查询，最多导出筛选范围内最新 5,000 条，包含正常离场记录；即使图表为空也可导出。

2026-09-11 发布 `20260911T065446Z` 已于 07:05:49 UTC（北京时间 15:05:49）最终验收通过，本次同步更新了 ProbeX **后端和前端**。主资源 `/assets/index-DwVJ9mqB.js`，HTTPS/健康、Nginx、静态资源与二进制哈希、认证查询和聚合筛选均通过，其他服务及配置未变。发布前 146,786 条结果全部保留，验收时 147,430；v4 34 条、任务 7、探针 7、Agent 1 保留。本次字段键不变，没有清理或改写历史。旧记录缺少原始结束原因，不能仅凭 `End_By=session_ended` 批量改判；字段仍未定版。

前两轮曾因验收脚本变量作用域错误和 Agent 能力列表排列顺序变化触发安全回滚，核实并修正验收逻辑后第三轮通过。失败、回滚和最终验收记录连同数据库在线备份留在受限远端发布目录，没有恢复整库。

07:06:55 UTC 最终复核服务正常、容器未变，结果 147,532，v4 34。Chrome 已核对加载来源为本仓库，但显示版本仍为 1.1.4；随后出现用户操作，因此停止浏览器动作，没有重载插件或 GuideX。服务端 `collector_schema_current=false`，须在 `chrome://extensions/` 重载插件至 1.1.5，再刷新空闲 GuideX 页面后采样；刷新 Results 只更新展示。本次未触发真实交互或 Auto-Test，新样本端到端验收尚未完成。下方 1.1.4 保留为历史发布事实。

本地验证：插件 87 项测试及语法检查、前端 21 项测试和生产构建、Go 全量 race/vet 通过。隔离浏览器验证了仅离场记录时保留 Done 明细和 Export、隐藏两个图表，以及混合样本中普通完成/失败仍可选；没有向 yghk 写入模拟记录。新增工具函数和单轮组件定向 ESLint 通过，Results 全文件仍有既有 `any` 等 lint 问题，未在本轮扩展修复。

2026-09-11 后续用户反馈 Chrome 已重载，并明确确认现有 14 条 `session_ended` 失败记录全部属于人脸消失后的正常离场。07:17:02 UTC（北京时间 15:17:02）在 yghk 完成一次性历史修复，仅按固定记录 ID 将顶层和 extra 的 `success` 改为成功；其他字段原值保留，不补造原始协议原因或节点。修复前完成在线 SQLite 备份、隔离模拟及回滚验证；34 条 v4 历史全部保留，成功数从 20 变为 34。07:17:08 UTC 线上明细及 JSON 导出各 34 条、趋势聚合 20 条，已修复离场记录不参与图表。所有非目标历史、其他表及容器/配置保持不变，没有重启或清库。备份、固定 ID 和前后快照留在远端受限 `releases/20260911T071419Z-history-repair/`。本次修复依据为用户明确确认，不将 `session_ended` 单独作为今后自动成功判定依据；新采样验收仍待真实交互。刷新 Results 即可，无需再次重载插件。

### 1.1.4 历史部署状态（yghk 前端已部署）

移除 `Audio_To_Speech`（数据键 `audio_start_to_speech_started`）的注册、上报和展示，保留独立的 `Speech_Started` 时间点。回答和播放时长短名分别改为 `Answer_Dur`、`Play_Dur`，数据键仍为 `answer_stream`、`avatar_speak_duration`，计时公式和单位不变。

yghk 前端发布 `20260911T043644Z` 已于 2026-09-11 04:39:14 UTC（北京时间 12:39:14）验收通过。独立浏览器在 Runtime v4 专属 Results 的趋势图、表格和底部单轮图核对了新短名；保留四个早期节点和七个间隔。主资源为 `/assets/index-dFDR2hW_.js`，后端未重启，其他服务、配置和端口未变。前端 17 项、插件 78 项测试及构建、定向 ESLint、语法检查通过。

按未定版规则，04:41:44 UTC 在单独事务中仅清理 `ext_guidex-runtime-v4` 的 3 条旧格式结果；四级汇总原本为 0，清理后目标记录和汇总均为 0。已保留受限的远端 SQLite 在线备份，其他 137,284 条结果、7 个任务、4 个探针、1 个 Agent 及非目标表计数和内容摘要未变，没有自动清理逻辑。

04:42:28 UTC 最终检查服务健康、认证 v4 查询为空，但 `collector_schema_current=false`：服务器注册仍不满足 1.1.4 字段。本次未重载 Chrome 插件或 GuideX 页面，未开启 Auto-Test 或发起真实交互。须重新加载 1.1.4 插件并刷新空闲 GuideX 页面后采样；单纯刷新 Results 只更新展示。新样本端到端验收未完成，旧注入页面及待重试队列仍可能上报旧格式。下方 1.1.3 记录保留为历史，不能据源码版本推定客户端已更新。

### 2026-09-11 LastAudio 口径部署状态（1.1.3 历史）

yghk 前端发布 `20260911T032612Z` 已于 03:30:25 UTC（北京时间 11:30:25）验收通过，趋势图、表格和底部单轮图使用 `LastAudio_To_STT/LastAudio_To_Answer/LastAudio_To_Play`，不再显示旧 `Stop_To_*` 或独立 `Test_To_Play`。后端未重启，其他服务、配置、证书和端口未变。

按未定版字段规则，03:32:31 UTC 仅清理 `ext_guidex-runtime-v4` 的 11 条旧口径测试记录；四级汇总原本为 0，清理后原始记录及汇总均为 0。已有 SQLite 在线备份，其他 133,742 条结果、7 个任务、4 个外部探针、1 个 Agent 及所有非目标表内容经事务内计数和摘要校验未变，没有自动清理任务。

本轮未重载 Chrome 插件或 GuideX 页面，源码版本为 1.1.3，服务端注册仍缺少三个新数据键。须重新加载插件、刷新空闲 GuideX 页面并完成新交互；单纯刷新 Results 只能更新展示，不能生成新指标。未发起真实对话或 Auto-Test，尚未完成新样本端到端验收。旧注入页面及其待重试队列仍可能上报旧格式，清理不自动拦截后续旧数据。

### 2026-09-10 部署状态

yghk 的去重后端和 14 节点英文时间线前端已于 08:49:14 UTC 发布验收，发布标识为 `20260910T083953Z`。此次不清理历史记录。Chrome 已核对加载目录正确，但仍显示 1.1.0，随后因 macOS 锁屏未能重载；源码为 1.1.2，不代表已注入页面。解锁后须重载插件并刷新空闲 GuideX 页面，再由用户完成一轮真实交互验收。服务端验收时该任务结果为 0，未向正式库填充模拟对话。

### 前端协议来源

本次适配参考本地 `guidex-front-monorepo` 仓库，分支为 `feature_v4_runtime_refactor`，提交为 `a3d6bd28b`，`@guidex/runtime` 版本为 `4.0.0`。源码核对日期：2026-09-09。

主要参考文件如下，路径相对于该前端仓库：

- `packages/gx-runtime/src/adapters/guidex/chat-wire.ts`：聊天消息封装及连接地址。
- `packages/gx-runtime/src/adapters/guidex/chat-audio-frame-port.ts`：音频上传。
- `packages/gx-runtime/src/adapters/guidex/draft-interaction-port.ts`：文本输入。
- `packages/gx-runtime/src/adapters/guidex/runtime-wire-codec.ts`：协议事件及字段校验。
- `packages/gx-runtime/src/vue/use-microphone-gesture.ts`：麦克风点击、长按及取消行为。
- `packages/gx-runtime/src/vue/components/InputView.vue`：当前音源的公开 DOM 状态。
- `packages/gx-runtime/src/vue/components/AudioIndicator.vue`：加载点和收音波形状态。
- `packages/gx-runtime/src/adapters/browser/create-browser-audio.ts`：权限、Worklet 初始化和首块 PCM。
- `apps/interaction-app/src/mount-interaction-app.ts`：会话等待与麦克风状态到页面的投影。
- `docs/2026-09-04-GuideX-Runtime-协议-1.0.md`：输入、模型和数字人播放的生命周期。

### 页面与连接识别

公开交互页面的路由为 `/#/interaction-app/:runId`，聊天 WebSocket 地址为 `/chat/api/chat/aichain/:instanceId?runId=...`，支持地址前带有路径前缀。

草案连接 `/api/runtime/v1/ws` 支持解析不含 `data` 包装层的入站 `payload`，用于协议回放；这不表示该地址已经通过生产环境验证。DeviceBridge 的 `/h5`、`/audio` 连接以及厂商 RTC 连接，不作为业务交互轮次的划分依据。

### 消息字段与标识

| 字段或事件 | 含义与要求 |
| --- | --- |
| `header.version` | 协议版本，必须为字符串 `"1.0"`；不同于前端包的 `4.0.0` 版本号。 |
| `header.sendAt` | 服务协议中的发送时间字段，参与格式校验，但不与浏览器本地时钟相减。 |
| `header.channel` | 必须与对应事件要求的 `control` 或 `data` 通道一致。 |
| `header.context.instanceId` | 当前业务实例标识。 |
| `header.context.sid` | 业务会话标识，一个会话内可以有多轮交互。 |
| `header.context.cid` | 当前会话中的业务交互轮次标识。 |
| 入站聊天消息 | 业务字段位于 `payload.data` 内。 |
| 出站聊天消息 | 业务字段直接位于 `payload` 内，不额外包裹 `data`。 |
| `instance.ready` | 仅表示实例注册完成，不表示业务会话已就绪。 |
| `session.started` | 必须同时满足 `payload.data.ready=true` 和有效的 `sid`，才表示聊天业务会话已就绪。 |

`runId`、厂商 RTC 的 `sid/requestId`、插件自身的 `node_id`，均不能替代业务 `instanceId/sid/cid`。

## 加载与版本切换

在插件仓库目录中执行：

```bash
git switch codex/guidex-v4-runtime
# 可选：运行本地校验，无需安装依赖
npm run check
```

1. 打开 `chrome://extensions/`，重新加载本插件。此分支的插件名称包含 `(GuideX v4)`。
2. 重新加载 GuideX 页面，使插件能在 WebSocket 和 `RTCPeerConnection` 创建前安装监听。仅更新插件，无法补回页面已经发生的历史消息。
3. 打开插件弹窗，保持 `Auto`，或选择 `Runtime v4` 后保存。观察到 `instance.ready` 后应显示注册状态，但这还不代表完成了一次业务交互。
4. 完成一次语音或文本交互。在 ProbeX 的结果页（`Results`）选择探针 `guidex-runtime-v4`，对应任务为 `ext_guidex-runtime-v4`，再按 Agent 或页面筛选。
5. 如果需要恢复旧版发布代码，切换到 `main` 后重新加载插件和页面。如果仍使用本分支监测旧版 GuideX 页面，可选择 `Auto` 或 `Legacy`，使用原有的 `guidex-interaction` 探针。

ProbeX 地址和可选的 `Ingest Token` 继续使用弹窗中的原有配置。WebRTC 质量数据仍上报到配置的 `Probe Name`，与新版业务交互指标分开。新版不会用新的事件含义覆盖旧版历史耗时字段。

## 事件映射

下表中的接收事件，其业务字段均指解包后的字段：聊天协议读取 `payload.data`，草案协议读取 `payload`。

| 方向与事件 | 字段与处理方式 |
| --- | --- |
| 发送 `conversation.user.append`，音频输入 | `payload.items[].type=audio`，且 `data` 为非空、有效的 Base64 数据；只记录首次和最后一次音频追加时间。 |
| 发送 `conversation.user.append`，文本输入 | `payload.input.type=text`，且文本非空；创建文本交互轮次。 |
| 发送 `guidance.trigger` | `payload.kind` 为 `welcome`、`invitation` 或 `farewell`；创建相应的引导交互轮次。 |
| 接收 `event.user_speech_started` / `event.user_speech_stopped` | 根据匹配的 `instanceId/sid/cid`，记录服务端通知的语音输入开始和结束时刻。 |
| 接收 `stt.result` | 读取 `text` 和布尔值 `isFinal`；按完整快照更新 `STT Text`，并记录首次非空结果和最终结果时刻。 |
| 接收 `event.stt_revocation` | 清空当前轮 `STT Text`、撤销 `Last_STT`；同一 `cid` 的迟到 STT 不再复活已撤销文本。 |
| 接收 `nlu.answer` | 根据 `operation=append/replace` 累加或替换回答长度，校验 `text`、`format` 和可选的布尔值 `final`；`final=true` 标记模型完成。空文本的最终 `append` 不清空已累计的长度。 |
| 接收 `nlu.postprocess` | 当 `status=completed` 且 `finalText/format` 有效时，可在模型尚未完成的情况下补充模型终态；不覆盖已经完成的模型记录。 |
| 接收 `avatar.speak.started` / `avatar.speak.ended` | 独立记录数字人业务播放生命周期。允许只有结束事件、没有开始事件，以支持无需播报的回复。 |
| 接收 `event.cid_end` | 仅记录独立的统计时间标记，不能替代输入、模型或数字人播放的完成事件。 |
| 发送 `event.interrupt` | 仅表示发出了中断请求，不视为服务端已确认中断。 |
| 接收 `event.interrupted` | 根据 `stages` 处理中断；聊天协议缺省时按 `nlu/tts/avatar` 处理，显式空数组不触发中断结束。 |
| 发送 `session.end` / 接收 `session.ended` | 使用同一连接、实例和会话的 `reason` 判断正常离场收尾；只发送请求不结束观测。确认 `presence_left` 且没有异常时记成功，保留 `End_By=session_ended`，详见下文。 |
| 接收匹配作用域的错误、异常/未知会话结束或连接关闭 | 以失败状态结束尚未完成的观测，保留已采集的部分指标，不伪造完整交互耗时。 |

### 轮次归属与隔离

每轮观测按“物理 WebSocket 连接 + `instanceId` + `sid` + `cid`”关联。实例注册、业务会话就绪且标识有效后，只有实际观察到出站输入才会创建轮次。

- 只有入站回复、没有对应出站输入时，不创建新记录。
- 缺少 `cid` 的消息不会借用所谓“当前轮次”，避免串轮。
- 连接断开时结束未完成观测；重新连接后使用独立的连接状态，不合并重连前后的尝试。
- 重复的模型终态或迟到的后处理消息，不会重写已经完成的模型计时。

## 指标口径

### 计时原则

协议事件、真实按下、麦克风申请/返回及界面就绪的时间锚点均来自本地 `performance.now()`。自动测试的触发也使用本地计时；`test_audio_duration` 则直接取解码后的样本时长。`start_at`、`interrupt_at`、`interrupted_at` 另存各自观测时刻的 ISO 时间用于定位，不参与耗时相减，避免系统时间调整影响耗时。所有耗时字段的单位均为毫秒（`ms`）。

`sendAt` 只做协议校验，不与本地时钟相减。因此，下列指标表示浏览器观察到的事件时间差，不等同于服务端纯处理耗时、单向网络延迟或真实声学延迟。完整字段定义以插件 `guidex-runtime.js` 中的 `schema` 为准。

下文“本轮输入起点”指首次观察到该轮有效出站输入的时刻：音频轮次取首次音频追加，文本轮次取文本发送，引导轮次取 `guidance.trigger` 发送。

### 默认业务时间线

对话最早观测时间统一命名为 `start_at`，`start_by` 解释开始原因。所有默认时间线数值均相对该起点，T=0 隐含，不再注册或上报恒为零的 `start`。当前实际可上报 `press`（已关联真实按下）、`auto_test`（插件自动触发）及 `first_input`（首次上传/输入，更早触发尚未观测）。多模态仅检测到音源而没有可靠 VAD 关联时，必须使用 `first_input`，不能谎报 `multimodal_vad`。

新自定义耗时字段全部移除 `_ms` 后缀，默认单位仍为毫秒；计数、回答字符数及 ISO 时间单独标单位。ProbeX 顶层标准字段 `latency_ms` 是通用 API 契约，保留名称，不做全系统迁移；新版业务图不重复展示该标准列。字段键、图表、表格、导出标题和注册字段说明均不带显示序号；`1st` 表示首次，继续保留。业务顺序由独立的字段排序配置维护，不从名称提取编号，也不按每轮数值强制排序。

| 字段 | 图表短名 | 时间锚点 |
| --- | --- | --- |
| `start_at` / `start_by` / `press_kind` / `input_source` | Start_At / Start_By / Press_Kind / Source | 未编号的基准元信息：绝对时间、开始原因、点击方式及音源，不作为数值节点。 |
| `mic_ready` | Mic_Ready | 从 `start_at` 到 H5 收音 UI 就绪：portrait 观察到收音波形而非加载点，其他布局观察按钮 `aria-busy=false`。 |
| `upload` | 1st_Audio | 本轮首次有效出站输入；以首次输入为起点时为 0。文本/引导轮次分别表示文本或引导发送，不表示实际上传了音频。 |
| `speech` | Speech_Started | 匹配本轮的 `event.user_speech_started`。 |
| `asr` | 1st_STT | 首个非空 `stt.result`。 |
| `upload_end` | Last_Audio | 最后一次音频追加，不等于实际停止说话。 |
| `input_end` | Speech_Stopped | `event.user_speech_stopped`。 |
| `asr_end` | Last_STT | 未被撤销的最终 STT 结果。 |
| `reply` | 1st_Answer | 首个非空 `nlu.answer`。 |
| `reply_end` | Last_Answer | 模型终态。 |
| `speak` | 1st_Play | `avatar.speak.started` 业务通知。 |
| `speak_end` | Last_Play | `avatar.speak.ended` 业务通知。 |
| `interrupt` | Trig_Interrupt | 匹配旧轮次的首个 `event.interrupt` 成功发送的本地观测时刻，不是下一轮按下时间。 |
| `interrupted` | Interrupted | 匹配旧轮次且 `stages` 非空的 `event.interrupted` 到达时刻。 |
| `end` | End | 观测结束，可能为成功、中断、超时、断连等。 |

本次保留数据键 `mic_ready`，删除 `start/mic_request/mic/ready` 及本轮可由时间线直接推导的冗余字段，英文短名不等于数据键重命名。`Mic_Ready` 合并此前申请、音轨返回、界面就绪的对外展示，计算为 `readyAt - origin`，不是三个累计偏移相加。内部仍可观察申请和音轨返回，但不再分别上报；没有可靠 `readyAt` 时为 `null`，不由申请或音轨返回推算。

这些是累计时间，不是互不重叠的阶段时长。界面更新可能晚于首帧发送，流式识别和模型处理也可能交错；不将数值排序或强制单调。缺失节点为 `null`，合法的 0 保留。为避免用户说话时长把后续节点整体推后，ProbeX 图表保留 `Mic_Ready`、`1st_Audio`、`Speech_Started`、`1st_STT`，并以关键区间耗时替代后续累计节点；表格和导出仍保留完整观测字段。正常结束包含确认打断，影响 `success` 与 `total_interaction/latency_ms`，见下文。

配套 ProbeX 分支为 `codex/guidex-v4-timeline`。选择新版探针后，页面按趋势图 `Turn Timing`、明细表/分页、底部单轮图 `Turn Timing` 的顺序展示。两个图表均保留上述四个早期节点，以及 `LastAudio_To_STT`、`LastAudio_To_Answer`、`STT_To_Answer`、`Answer_Dur`、`LastAudio_To_Play`、`Play_Dur`、`Interrupt_ACK` 七个间隔指标；单轮图使用当前表格页的原始记录，可切换轮次。只读取当前字段，不从其他阶段耗时反推缺失节点，不补造音源、点击或界面就绪。多轮趋势可能混合不同起点和聚合值，精确分析应查看单轮原始图。

图表、表格及导出的短名和枚举取值使用英文，解释性正文仍为中文。音源显示为 `Mic/Box/Unknown/N/A`，开始原因显示为 `Press/Auto/1st_Input`，点击方式为 `pointer/keyboard/click`，状态为 `Done/Interrupted/Failed`。预留的 `Box_VAD/Interrupt` 显示映射不代表已实现逐轮 VAD 关联，也不表示旧轮次确认打断会创建新轮。

### 间隔短名

当前跨阶段间隔采用 `_To_` 连接起止点；同一阶段的持续时长使用 `Answer_Dur`、`Play_Dur`。这两个短名分别替代 `1st_Answer_To_Last_Answer`、`1st_Play_To_Last_Play`，仅改标签，不改公式或数据键。`Audio_To_Speech` 已移除，当前指标以下表为准。

2026-09-11 的第一次命名调整将原带 `_Dur` 后缀的展示短名改用 `_To_` 连接起止点；那次仅调整标签和注册说明，不改变计时口径。随后本次 1.1.3 调整实际计时公式：所有原 `Stop_To_*` 改为从本轮 `Last_Audio` 起算，并使用新的 `last_audio_to_*` 数据键；`Test_To_Play` 删除，自动测试统一使用 `LastAudio_To_Play`。这不是将旧值换名，不维护旧 v4 别名，也不由旧时间点反推新字段。字段仍未定版；yghk 前端发布及本次受控旧测试清理已完成，插件/GuideX 重载和新样本验收仍待完成，详见上方 2026-09-11 部署状态。

| 数据键 | 当前短名 | 起点与终点 |
| --- | --- | --- |
| `last_audio_to_final_asr` | LastAudio_To_STT | `Last_STT - Last_Audio`：最后一次成功音频上传至最终 STT。 |
| `last_audio_to_first_answer` | LastAudio_To_Answer | `1st_Answer - Last_Audio`：最后一次成功音频上传至首个非空回答。 |
| `final_asr_to_first_answer` | STT_To_Answer | 最终 STT 至首个回答。 |
| `answer_stream` | Answer_Dur | `Last_Answer - 1st_Answer`：首个回答至模型终态；不是整轮结束。 |
| `last_audio_to_avatar_start` | LastAudio_To_Play | `1st_Play - Last_Audio`：最后一次成功音频上传至业务播放开始；自动测试使用同一口径。 |
| `avatar_speak_duration` | Play_Dur | `Last_Play - 1st_Play`：业务播放开始至业务播放结束。 |
| `interrupt_ack` | Interrupt_ACK | 打断请求至确认，短名保持不变。 |
| `first_answer` | Audio_To_Answer | 本轮首次有效出站输入至首个回答。 |
| `total_interaction` | Audio_To_End | 本轮首次有效出站输入至正常完成或确认打断；失败时为空。 |
| `observed` | Input_To_Observed_End | 本轮首次有效出站输入至观测结束，包含失败。 |
| `test_audio_duration` | Test_Audio_Start_To_End | 解码样本媒体时间轴的起点至终点，即样本时长；不是上传窗口或实际挂钟计时。 |

`LastAudio` 对应 `Last_Audio`（时间点数据键 `upload_end`），是同一物理连接、实例、会话和 `cid` 内最后一次成功发送的有效 `conversation.user.append` 音频追加。不等于物理停止说话、服务端 `event.user_speech_stopped` 或测试样本播放结束。三个间隔直接在插件中用本地原始锚点相减再四舍五入为毫秒；独立取整后的时间点相减可能相差 1 ms。两端任一缺失时为 `null`，不借用首次上传、其他轮次或测试样本结束；保留零值和负值。普通麦克风、多模态盒子和自动测试均使用同一公式；没有音频上传的文本/引导轮次保持为空。

`Audio_To_Answer` 和 `Audio_To_End` 沿用音频轮次的简写；文本和引导轮次仍取各自首次有效输入，均不从 `start_at` 起算。`Audio_To_End` 仅在自然完成或确认打断时有值，正常离场收尾也不补造该值。更新 ProbeX 前后端后需刷新 Results 页面；当前口径须重载 1.1.5 插件并刷新空闲 GuideX 页面后重新采集，刷新 Results 不能给旧记录生成新值。

### 音源及用户操作

| 字段 | 含义 |
| --- | --- |
| `input_source` | `browser_mic`（浏览器麦克风）、`multimodal_box`（多模态盒子）、`unknown`（无法可靠判断）、`not_applicable`（文本/引导）。 |
| `start_by` | `press`、`auto_test` 或 `first_input`。 |
| `start_at` | 对话最早可靠观测起点的 ISO 时间。点击取真实按下；首次输入取首包发送；自动测试从本地单调起点映射至本地墙钟。不是服务端 `sendAt`。 |
| `press_kind` | `start_by=press` 时为 `pointer`、`keyboard` 或 `click`；非点击起点为空。鼠标/触摸统一归为指针。 |

音源识别只读取公开 DOM：唯一可见 `.gx-input.gx-input-local` 表示本地多模态音源；非 local 输入区存在 `button.gx-microphone` 时表示浏览器麦克风入口。页面没有该结构、存在多个可见输入区或多个 Runtime 连接时记录为未知，不根据“没有点击”或“发现 /audio 连接”猜测多模态盒子。页面渲染状态可能短暂延迟，音源仍是本地观察结果，不是服务端证明。

`protocol_profile` 和 `source_evidence` 不再注册或上报，协议类型仅在内部用于解包。原 `press_at/timeline_origin` 也不再上报，由 `start_at/start_by` 统一替代。新版 ProbeX 不再兼容本适配开发期间的旧 `_ms` 和按下字段，缺失值保持缺失，合法的 null/0 不被推算值覆盖。

### 不再上报的非单轮字段

`ws_connect_ms`、`instance_register_ms`、`session_start_ms` 属于连接、实例注册或会话建立阶段，可能被多轮交互复用，不与单次对话强关联。因此，新版探针不再注册或上报这三个字段，包括正常完成及异常结束的轮次。

内部仍监听连接、实例和会话生命周期，用于就绪判断及轮次隔离。失效测试记录按上文的定版规则清理；重新加载插件和 GuideX 页面后，新产生的上报使用精简后的字段定义。

### 输入与识别

| 字段 | 计算方式与含义 |
| --- | --- |
| `last_audio_to_final_asr` | 本轮最后一次成功音频追加至未被撤销的最终 STT 结果；即 `Last_STT - Last_Audio`，保留正负号，不依赖语音结束通知。 |
| `stt_text` | 当前轮最新有效 STT 完整快照；被 `event.stt_revocation` 撤销后为空字符串，不保存中间版本历史。 |
| `stt_revocations` | 收到的识别撤销事件次数，作为诊断计数保留。 |

本轮不再注册以下可由主时间线直接表达或推导的字段：

- `Audio_To_Speech`（数据键 `audio_start_to_speech_started`）：首次音频追加至语音开始通知的间隔已移除；`Speech_Started` 时间点及对应协议事件观测仍保留。
- `Press_Audio_Dur`（数据键 `click_to_first_audio`）：按下到 `1st_Audio` 的差值；当 `start_by=press` 时本质上与 `1st_Audio` 使用同一对起点，保留会重复。
- `Audio_STT_Dur`（数据键 `audio_start_to_first_asr`）：`1st_STT - 1st_Audio`，由两个节点直接相减。
- `Upload_Dur`（数据键 `audio_upload_window`）：`Last_Audio - 1st_Audio`，由两个节点直接相减。
- `Audio (B)`、`Audio (frames)`（数据键 `audio_bytes`、`audio_frames`）：音频量和追加次数不属于当前业务时间线，且不再作为 Runtime v4 结果字段。
- `Input_Done`（数据键 `input_ended`）：表示是否收到输入结束事实；现在直接看 `Speech_Stopped` 是否有值。
- `STT_Final`、`STT_OK`、`STT (chars)`（数据键 `asr_final`、`asr_recognized`、`asr_characters`）：分别是最终标记、文本非空状态和字符数；现在由 `Last_STT` 与 `STT Text` 表达。

### 回答与数字人播放

| 字段 | 计算方式与含义 |
| --- | --- |
| `last_audio_to_first_answer` | 本轮最后一次成功音频追加至首个非空 `nlu.answer` 的时间差。 |
| `last_audio_to_avatar_start` | 本轮最后一次成功音频追加至 `avatar.speak.started` 的时间差；表示业务播放开始，不是真实可听见声音的时刻。自动测试不再使用独立的样本结束起点。 |
| `final_asr_to_first_answer` | 最终 STT 结果至首个非空回答的时间差。 |
| `first_answer` | 本轮输入起点至首个非空 `nlu.answer` 的耗时。 |
| `answer_stream` | 首个非空回答至模型终态的时间差。 |
| `avatar_speak_duration` | `avatar.speak.started` 至 `avatar.speak.ended` 的业务播放时长；没有开始事件时为 `null`。 |

`Model_Done`（数据键 `model_completed`）只表示是否观察到模型终态，不表示数字人已经播报完成；`Last_Answer` 已经记录该终态。`Audio_Model_Dur`（数据键 `model_complete`）是 `Last_Answer - 1st_Audio`，与现有时间线重复，因此两者都不再注册或上报。

### 整轮观测与自动测试

| 字段 | 计算方式与含义 |
| --- | --- |
| `cid_end` | 本轮输入起点至 `event.cid_end` 的耗时；仅为独立统计标记，不决定本轮成功。 |
| `total_interaction` / 标准字段 `latency_ms` | 本轮输入起点至正常结束，包括自然完成或确认打断。它不是完整播报时长；只分析自然完成时必须筛选 `completion_reason=completed`。异常结束保持 `null`。 |
| `observed` | 本轮输入起点至观测结束的时长；包括失败、中断、超时和断连等情况。 |
| `interrupt_at` | Trig_At：打断请求发送的本地 ISO 时间，归属于被打断的旧轮次。 |
| `interrupted_at` | Interrupted_At：打断确认到达的本地 ISO 时间，归属于被打断的旧轮次。 |
| `interrupt_ack` | 首个已观测打断请求至确认的单调时钟差；重复请求不重置起点，缺少本地请求时为 `null`。不能理解成服务端纯处理耗时。 |
| `test_audio_duration` | 自动测试音频样本解码后的时长，不是实际上传窗口时长。 |

缺少任一计时锚点时，对应字段为 `null`，不能按零耗时理解。跨阶段的负值会保留，因为流式识别、回答或播报通知可能先于最后一次音频追加被观测到，不能简单将这些负值判定为异常。

### 标识、计数与状态

| 字段 | 含义 |
| --- | --- |
| `client_adapter` | 客户端适配器标识，本实现为 `guidex-runtime-v4`。 |
| `instance_id` / `sid` / `cid` | 业务实例、会话和交互轮次标识。 |
| `input_type` | 输入类型：`audio`、`text` 或 `guidance`。 |
| `interaction_mode` | 观测模式：被动监听 `passive` 或自动测试 `auto-test`。 |
| `completion_reason` | 本轮观测结束原因，见下表。 |
| `error_code` | 通过校验的协议错误码；不可用时为 `null`。 |
| `page_url` | 已移除查询参数的页面地址。 |
| `stt_text` | 当前轮最新有效 STT 完整文本；撤销后为空字符串。 |
| `answer_characters` | 按回答的追加、替换及终态规则维护的文本长度。 |
| `stt_revocations` | 收到的识别修正事件次数。 |
| `cycle` | 自动测试的轮次编号；被动监听时为 `null`。 |
| `success` | 是否正常结束：`completed`、`interrupted` 和确认正常离场的 `session_ended` 为 `true`；异常或未知结束仍为 `false`。不以“出现识别文字”或仅发送结束/打断请求作为成功条件。 |
| `avatar_ended` | 是否观察到数字人业务播放结束事件。 |

`answer_characters` 按 JavaScript 字符串的 `length` 计算，不表示词数或模型 token 数，也不保证等于用户看到的字形数。`STT Text` 直接保存当前有效识别文本，不再另存 STT 字符数。

### 完成条件与异常结束

自然完成的音频轮次必须观察到输入结束、模型完成和数字人播放结束；文本及引导轮次不需要音频输入结束事件，但仍需模型和数字人播放终态。确认打断也属于正常结束，记录为 `success=true, completion_reason=interrupted`。识别成功、收到 `event.cid_end` 或仅发出中断请求，都不能单独证明正常结束。

正常离场属于单独的成功收尾，不等同于自然播报完成：

- 监听成功发出的 `session.end(reason=presence_left)`，按物理 WebSocket、`instanceId/sid` 关联；会话控制事件必须带 `sid`、不带 `cid`。不凭 DOM 人脸消失、`guidance` 类型或 `farewell` 候选推断会话已结束。
- 收到 `session.ended` 才收尾。若确认包显式带 `reason`，以服务端原因为准；未知、空值或不合法原因不降级为成功。确认包没有 `reason` 时，允许使用同一活动会话已观测到的结束请求原因；只接受精确的 `presence_left`。没有更早请求但服务端明确返回该原因，也可正常收尾。
- 匹配的会话/实例错误、上游 `event.idle_timeout` 或明确的非离场 `session.ending` 原因阻止改判成功；已记录的轮次错误、断连、超时不可被迟到确认覆盖。收到确认时已超过观测期限，仍按 `timeout` 结束。`idle/input_cancelled` 不在本次正常离场白名单中。
- 该会话尚未终结的引导、音频或文本轮次均可正常收尾；已完成/打断/失败的轮次不改写、不重复上报。请求原因不跨连接、实例、会话替换或重连继承。
- 成功收尾继续上报 `completion_reason=session_ended`，表格显示 `Done`。保留 `end/observed` 和确实观测到的部分节点；缺少的 STT、回答、播放终态保持为空，`avatar_ended` 不强制变成 true。`total_interaction` 和顶层 `latency_ms` 为空，避免把会话驻留时间算成完整交互耗时；成功率计入成功，完整交互耗时不计入。
- 以实际存储的 `success=true + completion_reason=session_ended` 从 Runtime v4 趋势聚合和单轮图排除；旧失败记录不靠显示层改判或隐藏。历史记录只有经明确确认并完成受控数据修复后才按成功离场处理，不能仅凭 `session_ended` 自动改判。普通完成、确认打断及异常记录的图表规则不变。明细和原始导出保留这些记录。

| `completion_reason` | 含义 |
| --- | --- |
| `completed` | 所需终态全部到齐，完整完成。 |
| `interrupted` | 收到有效且 `stages` 非空的中断确认，完成（打断）。 |
| `error` | 收到与观测作用域匹配的错误。 |
| `timeout` | 超过观测期限仍未完成。 |
| `disconnected` | WebSocket 断开。 |
| `session_ended` | 所属业务会话结束；确认正常离场时成功但不参与耗时图表，异常或原因不明时仍失败。 |
| `session_replaced` | 业务会话被新会话替换。 |
| `instance_closed` | 业务实例关闭。 |
| `capacity` | 达到活动轮次容量限制，提前结束最早的未完成观测。 |

默认观测期限为 60 秒，每条连接最多保留 64 个活动轮次。中断确认会结束测量窗口，但不推断输入或播放已经自然结束；被动监测不会因此改变应用的音频上传行为。

打断事件严格使用其自身的物理连接、`instanceId/sid/cid`，不能把新一轮按下时间填进旧轮次的 `interrupt`。只收到确认但没有本地请求时，仍可完成（打断），但请求时间及打断等待必须为空。显式空 `stages` 不作为确认；只有请求、没有确认时继续等待自然完成、错误或超时。已结束轮次的重复/迟到通知不会重复上报。

`interrupted` 与 `end` 在确认打断的轮次相同，但都不能替代 `speak_end` 或实际静音时间。`avatar_ended` 等事实字段不随成功口径被改成 true；模型完成由 `reply_end`、输入结束由 `input_end` 表达。

ProbeX 单轮选择器、结果表及导出使用 `Interrupted` 表示完成（打断），与自然完成 `Done` 和失败 `Failed` 区分；正常离场 `Done` 仅保留在明细/导出，不进入单轮选择器。成功率包含确认打断和正常离场，不能把它称为完整播完率；完整播放分析须筛选 `completion_reason=completed`。缺失的请求、确认或播放时间均不补造。

## 不可直接测量的指标

新版 TTS 音频由 GuideX 发往 Avatar，不再经过 H5，因此不能继续沿用旧版 `audio_end_to_tts_ms` 和 `tts_to_avatar_speak_ms` 的测量方式。

- 厂商的 `vmr_status` 和共享下行音频 RMS 无法可靠关联到新版业务 `cid`，因此不宣称能够提供逐轮的嘴部动作、口型同步或真实可听播放耗时。
- `avatar.speak.started` 只表示业务播放开始，不证明页面未静音、扬声器已出声或用户已听见声音。
- RTP 抖动、往返时间（RTT）、码率、帧数及抖动缓冲区音视频差值，仍由独立的 WebRTC 质量探针提供，不与业务轮次计时混为一谈。

## 数据保留与上报

新版结果保留业务标识、时间指标和最终有效 `STT Text`，不保存提示词、回答正文、Base64 PCM 音频或 RTC 凭据。只保留当前轮 STT 快照，不保存中间识别版本历史；页面地址会移除查询参数。

上报失败的结果会暂存在队列中重试，最多保留 100 条，每批最多上报 20 条。

## 新版自动测试

1. 在 GuideX 的设备助手中选择浏览器麦克风输入，并允许浏览器使用麦克风。
2. 在插件中捕获页面上处于可用状态的麦克风按钮，上传一段较短的测试音频，再点击 `Start`。
3. 插件触发页面现有的麦克风交互，等待应用首次上传音频后，再把解码后的测试样本送入麦克风混音器。
4. 每轮等待服务端输入结束、模型完成和数字人播放结束，再判定该轮结果。

会话及 `cid` 创建、PCM 编码、语音活动检测（VAD）和输入结束流程均由 GuideX 应用自身负责。插件不会发送旧版 `status=2`、空尾帧、猜测的 `cid`，也不会直接构造聊天音频包发送到服务器。

点击和长按模式使用 Runtime 已有的点击或 Enter 按键处理逻辑；长按模式会在样本播放结束后释放 Enter。停止或失败时会取消样本播放；如果捕获的麦克风按钮仍处于按下状态，则调用该按钮的 Escape 处理逻辑，取消本次采集。

出现重叠轮次或多个 Runtime 连接时，自动测试会停止并显示原因，避免把测试音频或结果归到错误的交互中。DeviceBridge 音频可以被动监听，但不会被合成测试音频替换。

浏览器音频注入需要安全上下文（HTTPS 或 localhost）及麦克风权限。

## 常见问题

### 能否监测浏览器麦克风按钮的用户点击？

已实现 GuideX 页面内麦克风按钮的被动监听。前端的 `InputView.vue` 为 `.gx-microphone` 绑定点击、指针和键盘事件，`use-microphone-gesture.ts` 将这些事件转换为采集意图：

- 点击模式：`click` 在空闲时启动，在采集中结束；不能把每次点击都当作开始。
- 长按模式：有效的 `pointerdown` 开始，匹配的 `pointerup` 结束；`pointercancel` 或失去指针捕获表示取消。
- 键盘模式：长按支持 Enter/空格的 `keydown` 和 `keyup`，Escape 表示取消；点击模式保留原生键盘触发按钮的语义。

插件在捕获阶段记录真实指针按下或 Enter/空格按下，也兼容没有前置指针/键盘事件的原生点击。要求 `isTrusted=true`，排除插件合成事件；同一次按下后产生的 click 不覆盖初始时间。鼠标右键、非主指针、按键重复、组合输入、禁用按钮及停止收音操作，不作为新一轮开始。

按下本身不创建业务记录。只有同一页面/连接中该次麦克风申请成功、按钮仍处于采集中，且应用实际发送首条音频时，才将操作关联到原生 `sid/cid`；一次操作最多关联一轮。权限拒绝、取消、恢复空闲、页面导航、切源、连接变化或未上传等待超过 30 秒时丢弃待关联操作。没有实际出站输入的失败点击暂不单独上报。自动测试的合成动作仍只标为 `auto_test`。

上述范围不包括 Chrome 地址栏麦克风图标或浏览器原生权限弹窗，它们不是页面 DOM 事件。

### 按下后的加载阶段，H5 在准备什么？

按当前前端实现，流程包含以下工作，具体是否需要等待取决于权限、资源及业务会话状态：

1. 检查实例、音源和当前采集状态，发起浏览器麦克风请求；首次使用可能等待用户授权。
2. 获取并校验有效音轨，建立指定采样率的 `AudioContext`。
3. 加载音频 Worklet 模块，创建 `guidex-pcm-capture`，连接音轨、处理节点及静音输出，恢复音频上下文运行。处理链按指定采样率生成 PCM16 并分片；当前手动模式不等待本地 VAD 判定开口。
4. 等待第一块真实 PCM，将浏览器音源标记为 `available`；业务资格不足时还需等待 `session.started(ready=true)`。等待 sid 时可按配置缓存最近音频，默认窗口 600ms；取得 sid 后创建 cid 并发送缓存及实时 PCM。
5. H5 根据采集状态及会话等待状态刷新界面：`starting` 显示加载点，可用收音状态显示波形。

所以内部音轨返回锚点 `micAt` 不能替代 UI 就绪锚点 `readyAt`；对外仅保留 `mic_ready`，它也不能替代 `upload`。portrait 布局在存在该版 `.gx-audio-indicator` 且观察到非 waiting 状态时记录；没有渲染波形的布局改为观察同一麦克风按钮公开的 `aria-busy=false`。两种方式都要求按钮仍处于收音状态且音轨已成功返回，不用单独的申请或音轨返回时间推算。多模态盒子、无浏览器麦克风按钮、权限失败或页面没有可靠 UI 状态时，`mic_ready` 保持 `null`。DOM 观测代表状态更新，不保证对应屏幕像素已经绘制。

被动监测保留 Runtime 的真实麦克风权限/设备失败，不把拒绝授权替换成成功的静音流。

### 374 ms 的启动准备为什么不能全算成授权耗时？

2026-09-10 的一次浏览器麦克风记录为：按下 0 ms，原生音轨返回 234 ms，界面就绪及首次上传约 374 ms。这只能拆为以下两段，不能事后恢复未采集的子阶段：

- 前 234 ms：包含按下到实际发起采集的时间，以及原生麦克风申请。点击模式在 `click` 才启动，插件记录的是更早的 `pointerdown`，因此可能包含手指/鼠标松开前的时间；不能声称全部是浏览器权限或硬件初始化。
- 后约 140 ms：包含音频处理链准备、首块 PCM 积累及事件/界面调度，必要时还有会话准入等待。当前 H5 每次停止会释放音轨并关闭 AudioContext，下次会重建上下文和 Worklet；这是按需释放设计，不是固定 374 ms 的定时等待。

旧插件被动监听也经过自动测试混音器，可能增加上下文创建/恢复及额外音频路径开销，具体贡献没有独立计时。本次改为 Runtime v4 被动监听直接返回原生 MediaStream，仅自动测试和旧版链路保留原有混音器。申请和音轨返回观测仅在内部保留，对外合并为 `Mic_Ready`，新记录不再单独上报这两个子阶段；Worklet、首 PCM、会话等待仍未被单独测量。是否实际降低延迟必须重新采集验证。

进一步优化 H5 可考虑提前缓存 Worklet 静态资源、减少重复装配；不能为了省几百毫秒擅自让麦克风在非交互期间持续采集。600 ms 是等待 sid 时的最大音频缓存窗口，不是每次必须等待的启动时间。

### 多模态盒子最早可以追溯到哪里？

按观测层级区分，不能把连接建立、任意设备音频或人脸出现当作单轮起点：

| 层级 | 最早可信锚点 | 当前是否已随业务轮次上报 |
| --- | --- | --- |
| 当前 ProbeX 插件 | 带原生 `instanceId/sid/cid` 的首次 `conversation.user.append` 音频发送；`start_by=first_input, upload=0`。 | 是。旧记录不能由此推算盒子真实采音时间。 |
| H5 的设备接入层 | 对应本轮、被准入的设备 BOS/首块 PCM 在 DeviceBridge `/audio` 消息处理器到达时的 `receivedMonoMs`。 | 否；Runtime 内部已有本地接收时间，但当前插件未采集及关联此锚点。 |
| DeviceBridge/物理盒子 | 助手收到设备音频、设备 VAD 开始或 ADC 采样时刻。 | 当前记录无此证据；需要设备/助手埋点、跨层轮次关联和可信时钟映射。 |

H5 的 `create-local-audio.ts` 在收到设备二进制音频时注入本地单调时间，解码器返回 VAD、通道、序号及 PCM。`create-device-audio-gate.ts` 还会检查唤醒资格、锁定通道并隔离被拒收的数据；不能把 `/audio` 上最早见到的包直接分配给下一次对话。早期纯 BOS 也可能被忽略或未获准入。

下一步若要把多模态起点前移，适合在 Runtime 准入后保留源连接代次、通道/BOS 与 `receivedMonoMs`，创建 `sid/cid` 时附带关联，再由插件只读取这些非音频时间元数据。可增加“盒子到达 → 首次上传”一段；字段仍统一为 `start_at`，其语义是“本轮 VAD 前端点到达 H5”，原因记为 `start_by=multimodal_vad`，不冒充物理开口时刻。当前解码出的 `seqId/frameIndex` 不是可信设备采集时间戳；也不应跨设备直接相减 `sendAt`。

### 最近一次 VAD 前端点能否作为新轮起点？打断时是否也有？

VAD 前端点是设备 `vad=1`（BOS），与结束端点 `vad=3`、云端 `event.user_speech_started`、旧轮次 `event.interrupted` 是不同事件。可用的是“被准入并确实产生本轮 cid 的 BOS”，不是全页面时间最近的任意 BOS。多通道、切设备、未唤醒、被拒收，以及 Cloud 模式同一轮内的重复 BOS 都必须隔离。当前前端 `create-audio-input.ts` 在已有有效 lease 时不一定分配新 cid，因此最新 BOS 不一定是新对话。

- 盒子语音插话：如果设备识别出新的语音前端点，通常会有 BOS；但仅靠 H5 源码不能保证每次用户插话都有独立 BOS 或新 cid，也不能认定 BOS 代表服务端已经终止旧回答。当前 H5 的多模态 onBos 只通知活动/引导协调器，未发现像浏览器点击路径那样显式遍历旧对话发打断请求；服务端是否自动打断须以实际协议事件为准。
- 点击浏览器麦克风：H5 会对未结束的旧 cid 发出打断请求，再开始新麦克风采集，不等待旧轮次确认。此时不要求盒子提供 VAD。
- 页面双击停播：可以只发送旧 cid 的打断请求，不开启新输入，因此也不要求 BOS，更不能因此创建新轮次。

新轮开始原因保留实际点击或可靠关联的 VAD；旧轮的“被打断”属于 `completion_reason`，不是其 `start_by`。单独收到 `event.interrupted` 不创建新轮、不改写原来的 `start_at`。若产品另需表达“新轮打断了上一轮”，应附加明确的前后 cid 因果关系，不能只依据时间相邻推定。

目前未修改 GuideX 前端，也未新增其准入元数据输出，故本次不宣称已经采集到逐轮 VAD 起点；ProbeX 前端预留 `multimodal_vad` 的显示名称，但新插件不会在缺少证据时生成该原因。

### 每个有识别结果的轮次都会收到 `event.user_speech_started` 吗？

不能根据当前前端代码作出这一保证。协议将该事件定义为“云端检测到用户语音”，并要求 GuideX 将上游 AIChain 的语音开始/结束事件映射到业务 `sid/cid` 后下发；它不是用户点击或浏览器开始采集事件。

前端分别处理语音开始事件和 `stt.result`，没有证明“每个产生识别结果的轮次，服务端必定先下发一次 started”。是否实际完整下发，还需要核对服务端实现和真实交互报文；监听安装过晚或连接断开也会造成观测缺失。

因此插件只在实际收到匹配事件时记录该时间。没有收到时，`Speech_Started`（数据键 `speech`）为 `null`，不能用首次点击、首次音频或首个 STT 结果补造。缺少 started 不阻止其余指标计算，也不单独导致整轮失败；自然完成仍要求输入结束、模型完成和数字人播放结束，确认打断另按上述正常结束口径处理。

### 能否判定 Avatar 开始和停止说话的时间？

可以按匹配的 `instanceId/sid/cid` 记录业务事件在浏览器中的到达时刻：`avatar.speak.started` 表示业务播报开始，`avatar.speak.ended` 表示业务播报结束。两者之差为 `avatar_speak_duration`；开始事件还用于 `last_audio_to_avatar_start` 等指标。

当前实现内部保留起止计时锚点，上报对应的耗时指标，不单独上报起止的绝对时间戳。这些计时是浏览器观察到的业务事实，不是服务端原始发生时间，也不是扬声器真正出声或静音的时刻；网络传输、RTC 缓冲、解码、自动播放限制和页面静音都可能造成差异。

无需播报的回复允许只有 `avatar.speak.ended`，此时可确认播放终态，但不能声称曾经开始说话，播放时长为 `null`。中断或错误会按其自身原因结束观测，不能伪造一个正常的 `avatar.speak.ended`；仅收到中断时也不能将它换算成实际停止出声时间。

## 验证范围与边界

`npm run check` 包括语法检查、合成协议回放，以及在模拟原生 WebSocket 和上报接口下执行的页面主执行环境（`MAIN`）脚本集成检查，覆盖以下场景：

- 实例注册和会话就绪条件。
- 多个 `cid` 的交错事件及轮次隔离。
- 识别修正和流式回答终态。
- 确认打断正常结束，以及断连、超时等异常结束。
- 指标字段定义与结果上报。
- 自动测试中的麦克风复用。

自动化测试还覆盖非单轮字段不再注册/上报，以及识别轮次缺少语音开始通知、数字人重复开始通知时的计时行为。实际通过情况以 `npm run check` 的最新输出为准。

尚未完成真实浏览器语音交互的端到端验证。自动化测试通过不等于已验证真实服务端、物理麦克风、扬声器或 DeviceBridge 的行为。

看到“已注册”或获得一次 `getStats` 采样，也不等于完成了语音交互。真实环境验证应单独记录前后端版本、测试输入方式、实际终态事件及 ProbeX 上报结果。
