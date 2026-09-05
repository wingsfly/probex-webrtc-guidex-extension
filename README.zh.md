# ProbeX WebRTC + Guidex Chrome 扩展

> [English](README.md) | 中文

用于在浏览器页面上监测 WebRTC 音视频质量的 Chrome MV3 扩展，并针对讯飞 Guidex 数字人交互测试做了专门支持。

## 功能

### WebRTC 质量监测
- Hook `RTCPeerConnection.getStats()`，采集 inbound-rtp、outbound-rtp、candidate-pair 统计
- 500ms 子采样，2s 聚合后推送到 ProbeX 后端
- 指标：延迟、抖动（音/视频）、丢包、上下行码率、抖动缓冲延迟
- 跨 PC 抖动缓冲聚合（Guidex 的音、视频用**独立的 PeerConnection**）

### Guidex 交互探针（自动拨测）
- **元素捕获**：点选页面任意元素作为测试触发按钮
- **音频注入**：上传 WAV/MP3 测试音频，以 16kHz 16-bit PCM 帧直接经 voiceDictation WebSocket 注入
- **Web Worker 定时器**：即使浏览器标签页隐藏（远程桌面断开场景）也能精确控制 40ms 音频帧节奏
- **端到端计时**：18+ 项指标覆盖完整交互生命周期

### 交互计时指标（Interaction Timing）

在 `guidex-interaction` 探针下上报，每轮自动拨测一条记录。指标按交互生命周期分组。
各指标逐项分析见
[docs/interaction-metrics-analysis.md](docs/interaction-metrics-analysis.md);
迪拜↔利雅得链路与 `click_to_vd_ready_ms` 完整拆解见
[docs/network-latency-analysis-riyadh.md](docs/network-latency-analysis-riyadh.md)。
某字段为 `null` 表示对应事件从未发生（例如 ASR 失败时，下行的每一项都为 null），
这是主要的失败信号。

**时间线锚点**（均由扩展在页面内打点）：

| 锚点 | 时机 |
|------|------|
| `tClick` | 点击触发按钮（交互起点） |
| `tVdOpen` | voiceDictation WebSocket `open` 事件(握手完成) |
| `tVdReady` | voiceDictation WS 上发出首帧（会话就绪） |
| `tAudioStart` / `tAudioEnd` | 注入测试音频的开始 / 结束（“用户说话”起止） |
| `firstAsrTime` / `finalAsrTime` | 首个 ASR 词 / 最终 ASR 结果返回 |
| `ttsStartTime` | 首个 TTS 合成事件（autoReport WS `textChat` + `isAudioDriver`） |
| `firstVmr1Time` | 数字人嘴开始动（`vmr_status=1`） |
| `actualAudioStart` / `actualAudioEnd` | 客户端**实际听到**回复音频的起 / 止（AnalyserNode RMS 检测） |

**状态 / 标识**

| 字段 | 含义 |
|------|------|
| `success` | 是否识别出语音（`firstAsrText` 非空） |
| `asr_text` | 识别出的文本（最终结果，回退首词） |
| `audio_duration_ms` | 注入测试音频的原始时长（WAV 解码后） |
| `page_url` | 交互所在页面 URL |
| `cycle` | 拨测轮次 |

**上行 —— 点击 → 说话 → 识别**

| 短名 | 字段 | 公式 | 含义 |
|------|------|------|------|
| Click->Open | `click_to_vd_open_ms` | `tVdOpen − tClick` | 点击到 voiceDictation WS **open**——GuideX 点击处理 + 会话/token 请求 + 全新 WSS 握手（TCP+TLS+WS Upgrade） |
| Click->VD | `click_to_vd_ready_ms` | `tVdReady − tClick` | 点击到 WS 上发出首帧（会话就绪）。`ready − open` = open 后应用初始化（约数 ms） |
| 1st ASR | `audio_start_to_first_asr_ms` | `firstAsrTime − tAudioStart` | 首字延迟 |
| ASR Tail | `audio_end_to_final_asr_ms` | `finalAsrTime − tAudioEnd` | 说完到出最终 ASR 结果 |

> `tVdOpen` / `tVdReady`由 WS 的 `open` 事件与其上首次 `send()` **事件打点**（非轮询），
> 因此不含轮询量化误差。每轮交互都**新开**一条 voiceDictation WSS（零复用），所以
> `click_to_vd_open_ms` 主要由到端点的握手往返决定。

**下行 —— 理解 → 合成 → 数字人开口**

| 短名 | 字段 | 公式 | 含义 |
|------|------|------|------|
| Wait TTS | `audio_end_to_tts_ms` | `ttsStartTime − tAudioEnd` | 说完到首个 TTS 事件（含大模型思考时间） |
| TTS->Lip | `tts_to_avatar_speak_ms` | `firstVmr1Time − ttsStartTime` | TTS 事件到数字人开始动嘴 |
| Wait Play | `audio_end_to_playback_ms` | `actualAudioStart − tAudioEnd` | 说完到真正听到回复（主观等待） |

**播放 / 唇形同步**

| 短名 | 字段 | 公式 | 含义 |
|------|------|------|------|
| Play Dur | `actual_audio_duration_ms` | `actualAudioEnd − actualAudioStart` | 客户端回复音频播放时长（RMS） |
| Avatar Dur | `avatar_speak_duration_ms` | `avatarSpeakEnd − avatarSpeakStart` | 数字人说话总墙钟时长 |
| Lip Move | `lip_move_ms` | Σ(`vmr` 1→2) | 嘴真正在动的累计时长 |
| Lip Sync | `lip_sync_diff_ms` | `actual_audio_duration − lip_move` | >0 = 音频播放时长长于唇动时长 |
| Lip->Play | `vmr_to_actual_audio_ms` | `actualAudioStart − firstVmr1Time` | 音画同步；负值 = 声音早于嘴动 |

**总计**

| 短名 | 字段 | 公式 | 含义 |
|------|------|------|------|
| Total | `total_interaction_ms` | `actualAudioEnd − tClick`（逐级回退：avatarSpeakEnd → ttsStart → finalAsr） | 端到端：点击到回复音频播放结束 |

### WebRTC 质量指标（Guidex Sim）

浏览器侧每个推送区间（默认 2s）从 `RTCPeerConnection.getStats()` 采样，在 `Guidex Sim`
探针下上报。标注 *hidden* 的字段在输出 schema 里带 `default_hidden`（图表默认不显示，
仍可在图例里勾选）。

| 字段 | 含义 | getStats 来源 |
|------|------|--------------|
| `latency_ms` | 端到端往返时延（ms） | `remote-inbound-rtp.roundTripTime`×1000（回退 candidate-pair RTT） |
| `packet_loss_pct` | 丢包率（%） | packetsLost /（packetsReceived + packetsLost）区间差 ×100 |
| `download_bps` | 下行码率 | inbound-rtp `bytesReceived` 差值 ×8 / 区间 |
| `upload_bps` | 上行码率 | outbound-rtp `bytesSent` 差值 ×8 / 区间 |
| `audio_jitter` | 音频 RTP 到达抖动（ms） | inbound-rtp(audio) `jitter`×1000 |
| `video_jitter` | 视频 RTP 到达抖动（ms） | inbound-rtp(video) `jitter`×1000 |
| `video_fps` | 视频帧率（fps） | inbound-rtp(video) `framesPerSecond` |
| `video_frames_decoded` *hidden* | 每推送区间解码帧数（≈ `video_fps` × 区间，25fps/2s ≈ 50） | inbound-rtp(video) `framesDecoded` 差值，窗口内求和 |
| `video_frames_dropped` *hidden* | 每推送区间丢帧数（健康时为 0） | inbound-rtp(video) `framesDropped` 差值，窗口内求和 |
| `audio_jb_delay_ms` | 音频抖动缓冲播放延迟（ms） | (`jitterBufferDelay` 差值 / `jitterBufferEmittedCount` 差值)×1000 |
| `video_jb_delay_ms` | 视频抖动缓冲播放延迟（ms） | 同上，视频 inbound-rtp |
| `av_sync_diff_ms` | 音画同步：最新 videoJB − audioJB（ms） | >0 = 视频滞后于音频 |
| `available_outgoing_bitrate` *hidden* | 估算的可用上行带宽（bps） | candidate-pair `availableOutgoingBitrate` |
| `connection_count` *hidden* | 活跃 PeerConnection 数 | 跟踪到的 PC 数量 |
| `quality_limitation` | 编码器质量受限原因 | outbound-rtp(video) `qualityLimitationReason`（cpu/bandwidth/none） |
| `page_url` | 来源页面 URL | `location.href` |

> 注：数字人的音、视频跑在**独立的 PeerConnection** 上，所以每个 500ms 子采样只带一侧的
> inbound-rtp 字段。扩展在 2s 窗口内合并两侧：瞬时字段
> （`video_jitter`/`video_fps`/`*_jb_delay_ms`）取最新非空值，而可累加的帧计数
> `video_frames_decoded`/`_dropped` 在窗口内**求和**（真实的每区间计数）。audio PC 的子采样
> 会把视频字段留成 null 而非 0，以免覆盖 video PC 的真实值。`video_fps` 是 getStats 给出的
> 实时解码帧率。

## 架构

```
┌─────────────┐    postMessage    ┌──────────────────┐    fetch proxy    ┌──────────────┐
│  popup.html  │ ◄──────────────► │  content-script   │ ◄──────────────► │ background.js │
│  (配置 UI)   │                  │  (桥接层)          │                  │ (Service Worker)│
└─────────────┘                  └──────────────────┘                  └──────────────┘
                                         ▲
                                         │ postMessage
                                         ▼
                                 ┌──────────────────┐      HTTP POST     ┌──────────┐
                                 │   injected.js     │ ─────────────────► │  ProbeX   │
                                 │  (MAIN world)     │                    │  Server   │
                                 │  - WebRTC hooks   │                    └──────────┘
                                 │  - WS hooks       │
                                 │  - 音频注入        │
                                 │  - 统计采集        │
                                 └──────────────────┘
```

- **injected.js**：运行在页面 MAIN world。Hook `RTCPeerConnection`、`WebSocket`、`getUserMedia`，包含全部测量逻辑。通过周期性重新注入，绕过 SES（Secure EcmaScript）锁定。
- **content-script.js**：连接 chrome.storage 配置与 injected.js 的桥接层。为混合内容（HTTPS 页面 → HTTP ProbeX）把 fetch 请求经 background SW 代理转发。
- **background.js**：轻量 Service Worker，负责 popup 查询、fetch 代理、以及更新时重新注入。
- **popup.html/js/css**：配置 UI，含自动拨测面板（捕获按钮、上传音频、区间配置、启停）。

## 安装

1. 打开 `chrome://extensions/`
2. 开启**开发者模式**
3. 点击**加载已解压的扩展程序**
4. 选择本项目文件夹

## 配置（通过 popup）

- **ProbeX URL**：推送指标的 HTTP 端点（如 `http://your-server:8080`）
- **Push Interval**：统计聚合窗口（默认 2s）
- **Auto-Test**：捕获页面按钮、上传测试音频、设置区间、开始循环拨测

## 多客户端(如何区分)

同一探针的所有客户端都以共享 `task_id`(`ext_<probeName>`)上报,靠两个 id 区分:

- **`agent_id`** —— 标识**客户端**。在 popup 里设置;留空则自动生成 `browser-<随机>`。
  **它存在 `chrome.storage.local`,同一浏览器 profile 的所有标签页/窗口共享** —— 所以
  同机同 profile 的所有页面上报的是**同一个** `agent_id`。给每台机器起个有意义的名字
  (如 `dubai-pc1`)便于辨认。
- **`node_id`** —— 标识**页面/标签页**。每次页面加载生成(`pg-<随机>`)并自动上报,
  于是同一 `agent_id` 下的不同页面/标签页也能区分开。

在 ProbeX **Results** 页:先选 task,再用 **Agent** 下拉筛选到某个客户端(图表+表格联动);
选中客户端后出现 **Page** 下拉,可进一步筛到它的某个页面/标签页。(`agent_id` 过滤对既有数据即生效;
`node_id` / Page 下拉需**扩展 reload 后**新数据携带 node_id 才会有内容。)

## 测试音频

`audio/` 目录含用于自动拨测的示例 WAV 文件：
- `hello_introduce.wav` —— 基础问候测试音频

## 说明

- 扩展通过周期性重新注入 hook，绕过 SES 锁定（讯飞 XRTC SDK 使用）
- 音频注入把 PCM 帧直接送入 voiceDictation WebSocket，绕过 getUserMedia/MediaRecorder
- Web Worker 定时器保证标签页隐藏/后台时仍能精确控制 40ms 帧节奏
- 统计推送经 background SW fetch 代理以绕过混合内容限制，并带直连 fetch 回退
