# GuideX 交互指标逐项分析

> 对 `guidex-interaction` 探针各项指标的实测分析与修复记录(20.4 生产数据 + 迪拜 Chrome 实时抓取)。
> 相关:迪拜↔利雅得链路与 `click_to_vd_ready_ms` 的网络深挖见
> [network-latency-analysis-riyadh.md](network-latency-analysis-riyadh.md)。

指标定义与短名见 [README](../README.md#interaction-timing-metrics)。

---

## 1. `click_to_vd_ready_ms` / `click_to_vd_open_ms`(Click→VD / Click→Open)

结论摘要(详见网络文档):
- `~150ms` 全新 WSS 握手 = **3 个网络 RTT**(TCP+TLS+WS Upgrade),纯网络往返;
- 波动主因是点击→建 socket 之间的会话/token API(~140~290ms);
- 已把打点从 100ms 轮询改为**事件驱动**(WS `open` / 首帧 `send`),并拆出 `click_to_vd_open_ms`。

---

## 2. `audio_end_to_final_asr_ms`(ASR Tail)

图表短名 **ASR Tail**;定义 `finalAsrTime − tAudioEnd`(说完话 → 最终识别结果)。

### 2.1 初始观测(20.4,最近 2h,n=119)
- ASR Tail = **615~689ms,avg 632**,分布**极窄**(±5%)。
- 音频固定 3326ms(同一句 "Hello. Can you introduce the product?"),识别每次都正确一致。
- 反常点:1st ASR = 4433ms(从音频开始),而音频才 3326ms → 首字竟在音频结束后 ~1.1s 才到,且 **1st ASR(4433)> final(3326+632=3958)**,看似矛盾。

### 2.2 实时消息抓取(迪拜 Chrome,recv 侧)
```
0ms     WS create
221ms   open
223ms   SEND {"status":0}  会话初始化
...     音频帧(status:1 文本)经 OrigWebSocket.prototype.send 发送
5443ms  recv status=1  words="Hello. Can you introduce the..."   ← 首个带词结果
5445ms  recv status=2  words="Hello. Can you introduce the..."   ← 最终结果(仅晚 2ms)
```

由此确认:
1. **ASR 非流式**:音频播放期间无带词中间结果;整句在结束后一次性返回(status=1 紧接 status=2,相隔 2ms),故 **first ≈ final**。
2. **"矛盾"的真因是音频注入慢**,而非打点错。

### 2.3 三个根因

**根因 A — 发 end 前有 300ms 硬编码延时**
```js
const tAudioEnd = performance.now();
await new Promise(r => setTimeout(r, 300));   // ★ 固定等 300ms
sendVoiceDictationEnd();                        // 才发 status=2
```
服务端在收到 status=2 后才收尾(音频期间无返回,结果在 end 信号后 ~332ms 才来)→ 这 300ms **在关键路径上**,直接把 ASR Tail 抬高 300ms。
> ASR Tail 632ms = **300ms(插件延时)** + ~332ms(网络往返 ~100ms + 服务端识别收尾 ~230ms)。

**根因 B — 音频注入比实时慢 ~14%**
worker 用 `setTimeout(tick, 40)`(相对调度),把每次 tick 的 postMessage/回调开销累加,83 帧后 3326ms 的音频实发 ~3803ms。→ `tAudioEnd` 相对 `tAudioStart` 偏移,导致 1st ASR(锚 tAudioStart)与 ASR Tail(锚 tAudioEnd)看似矛盾。

**根因 C — 注入前的设置开销 ~344ms 被算进注入窗口**
`tAudioStart` 打在预编码(84 个 base64 块)+ `new Worker()` **之前**,这 ~344ms 设置开销被计入音频窗口。改 B 后仍有此项,故 `first − tail` 仍 ~3670。

### 2.4 修复(均在插件侧)

| commit | 修复 |
|--------|------|
| `8f4bfd1` | 发 end 前延时 **300ms→100ms**(留 2× 单程余量防尾音截断);ASR Tail ↓~200ms |
| `b744d7b` | worker 改**绝对目标调度**(帧 i 目标 = t0 + i×interval,按真实时钟纠偏),消除累积漂移 |
| `689a30a` | `tAudioStart` 锚定**真正首帧发送时刻**(playTestAudio 返回 firstFrameAt),排除预编码/worker 启动开销 |
| `dadc86f` | 新增 `audio_inject_ms`(= tAudioEnd − tAudioStart,真实注入窗口,应 ≈ audio_duration),让自洽关系可直接核对 |

### 2.5 验证(20.4,reload 后)

| 指标 | 修复前 | 修复后 |
|------|:--:|:--:|
| ASR Tail | ~632ms | **~430ms**(100ms 缓冲 + ~330 服务端) |
| 1st ASR | ~4433ms | **~3790ms** |
| **first − tail** | 3670~3950(乱跳) | **稳定 3361ms** ≈ 音频时长 3326 |
| 识别文本 | 完整 | 完整(尾词未截断) |

`first − tail` 稳定等于音频时长(差 ~35ms = 尾帧 tick + 取整),证明:**注入贴合实时 + 1st ASR 与 ASR Tail 自洽**。

### 2.6 结论
- 服务端真实 ASR 收尾 **~230~330ms**:合理(云端最终解码/标点的正常水平)。
- 报告值此前被 **300ms 插件延时 + 注入偏差**污染,现已消除;Tail 现为诚实的"说完→最终识别"。
- 该指标基于**固定测试音频**,反映的是这一句的确定性延迟,不代表不同语音下的 ASR 鲁棒性。
- 附带发现:服务端**偶尔**会吐流式中间结果(抓到过一次 first=1071 的早期 partial),但多数为非流式——这属于服务端行为。

---

## 3. `audio_end_to_tts_ms`(Wait TTS)

图表短名 **Wait TTS**;定义 `ttsStartTime − tAudioEnd`(说完话 → 首个 TTS 事件)。
`ttsStartTime` 打点在 autoReport WS 的 `textChat`+`isAudioDriver` 事件(服务端真实触发时刻)。

### 3.1 数据(20.4,最近 2h,n=117)
avg **1485ms**,范围 1025~1845,96% 落在 1200~1800(比固定量指标离散大)。

### 3.2 构成(Wait TTS 包含 ASR Tail)
| 段 | 值 | 含义 |
|----|----|------|
| ASR Tail(说完→最终识别) | ~430ms | 前置步骤 |
| **final ASR → 首个 TTS 事件** | **~870~1050ms** | **大模型生成回复 + 触发 TTS(主导)** |
| = Wait TTS | ~1300~1485ms | |

`Wait TTS ≈ ASR Tail(~430) + LLM 生成并启动 TTS(~900,主导且波动最大)`

### 3.3 结论
- 主导项 ~900ms 是**服务端对话模型**对固定问句生成应答的延迟;输入固定却有 ~800ms 抖动 → **模型/后端负载波动**,非确定性。
- 对 LLM 数字人 ~1.5s 才开始合成属可接受但不算快;杠杆在服务端(流式首 token、更热/更小模型),**插件侧无可优化**、测量准确。

---

## 4. `audio_end_to_playback_ms`(Wait Play)

图表短名 **Wait Play**;定义 `actualAudioStart − tAudioEnd`(说完话 → 客户端**真正听到**回复音频)。
`actualAudioStart` 由 AnalyserNode RMS 能量检测(仅在 finalAsrTime 之后计),是**最贴近用户主观等待**的指标。

### 4.1 数据(20.4,最近 2h,n=98)
avg **2203ms**,96%(94/98)在 2000~2500;偶发离群(见过 7723ms,某轮 LLM/TTS 卡顿)。

### 4.2 全链路拆解
| 段 | 值 | 性质 |
|----|----|------|
| ASR Tail(说完→最终识别) | ~430ms | 服务端 ASR 收尾 |
| LLM 生成回复(final ASR→TTS 事件) | ~870ms | 服务端大模型(主导波动) |
| TTS 首块合成+下发+检测(TTS 事件→听见) | ~790ms | 服务端 TTS + WebRTC 下发 |
| = **Wait Play** | **~2100ms** | 说完→听见 |

`Wait Play ≈ ASR(430) + LLM(870) + TTS 合成下发(790)`,三块全在服务端。

### 4.3 音画同步(健康)
`tts_to_lip` ~700ms vs `tts_to_play` ~790ms → **嘴比声音早 ~80ms**;`vmr_to_actual_audio_ms` 实测 65~107ms(正值小、口型略领先声音),属自然同步,无明显唇音错位。

### 4.4 结论与改动
- ~2.2s 主观等待对 LLM+TTS 数字人属偏高但正常;三大块全在 GuideX 后端,**插件无可优化**。
- 插件侧测量偏差:`actualAudioStart/End` 原用 **50ms RMS 轮询**,给 Wait Play / `actual_audio_duration_ms` 带 ~25~50ms 正向滞后。**已将轮询 50ms→20ms**(commit 见 git log),提检测精度。
- 服务端优化杠杆:**流式 TTS(边合成边下发)** 可砍掉 ~790ms 首块等待;更快 LLM 砍 ~870ms。

---

## 5. 播放/唇形时长系列(actual_audio_duration / avatar_speak / lip_move / lip_sync_diff)

### 5.1 数据(20.4,最近 2h)
| 指标 | 值 | 说明 |
|------|----|------|
| `actual_audio_duration_ms`(Play Dur) | ~13364ms | 回复音频播放时长 |
| `avatar_speak_duration_ms`(Avatar Dur) | ~13755ms | 数字人说话墙钟 |
| `lip_move_ms`(Lip Move) | ~13178ms | 累计唇动 |
| `lip_sync_diff_ms`(Lip Sync) | ~185ms | 音频比唇动长 185ms |
| `tts_total_duration_ms`(TTS Len) | **null(坏死)** | 见下 |

- 回复 ~13.4s(对固定问句生成 ~13s 产品介绍,内容长度非性能问题),play/avatar/lip 三者一致。
- **唇音同步良好**:`lip_sync_diff ≈ 185ms`(占 13s 的 1.4%),结尾自然收尾,无错位。

### 5.2 两个协议漂移引发的问题(`tts_duration` 事件消失)
- **`tts_total_duration_ms` 恒 null**:仅由 interact WS 的 `event_type:'tts_duration'` 累加,该事件已随协议改版消失。
- **完成判定空等 ~8s**(更要紧):`ttsSegmentCount` 也只在该死事件自增 → 恒 0 → 完成条件 `ttsSegmentCount>0 && lipSegmentCount>=ttsSegmentCount` 永不触发 → 每轮空等到 25s 硬超时(数字人其实 ~14s 就说完)。

### 5.3 修复与教训
| 项 | 结果 |
|------|------|
| **①(a)** ✅ | **移除** `tts_total_duration_ms`(冗余,avatar/play 时长已表征回复长度);连带清理死事件处理与孤立变量(ttsTotalDuration / ttsSegmentCount / lipSegmentCount)及 README/前端 label |
| **②** ❌ 已回退 | 曾尝试"末段 vmr=2 后静默 3s 即退出"来省 ~8s,**实测截断回复**:数字人回复是**多段 TTS、段间间隔 >3s**,3s 窗口在第一段(~1s)后就误判结束,avatar_dur 从 14s 塌到 1s。**结论:原来的 25s 固定等待不是浪费,而是覆盖多段回复 + 慢周期离群(见过 wait_play 7.7s → 回复在 tAudioEnd 后 ~22s 才结束)的必要安全余量。** 已回退为固定超时(15s 无 ASR / 25s 有 ASR / 60s 硬顶)。 |

> 教训:`tts_duration` 段计数消失后,**没有可靠的"回复结束"信号**(driver_status 段间有大间隔,音频能量也会在段间跌零)。在拿到新协议的"结束"标志前,固定超时是正确选择,不应为省时间牺牲完整性。

---

## 6. `tts_to_avatar_speak_ms`(TTS→Lip)

定义 `firstVmr1Time − ttsStartTime`(server 宣告音频驱动回复开始 → 数字人首次动嘴 vmr=1),即**数字人首帧口型启动延迟**。

### 6.1 数据(20.4,最近 3h,n=191)
avg **726ms**,范围 447~1081,84% 在 600~800(输入固定,较稳)。

### 6.2 含义与定位
这 ~730ms 全在服务端:TTS 合成首块音频 → 生成 viseme(口型)→ avatar 驱动器吐首个 vmr=1。
在感知链路中:
```
说完 →(wait_tts ~1290)→ TTS开始 →(tts_to_lip ~730)→ 动嘴 →(~80ms)→ 听见
wait_play ≈ 1290 + 730 + 80 ≈ 2100 ✓(自洽)
```
是 ~2.1s 主观等待里的一段;`lip_vs_audio ~75ms`(嘴比声音早 ~80ms),音画同步良好。

### 6.3 结论
- ~730ms 首帧口型延迟对云端数字人正常;**全在 GuideX 后端**(TTS 首块 + viseme + 驱动),插件测量准确、无可优化。
- 杠杆在服务端(流式 TTS + 更快首块 viseme)。

---

## 7. 待分析
- `vmr_to_actual_audio_ms`(唇音同步细节:口型 vs 声音先后)
