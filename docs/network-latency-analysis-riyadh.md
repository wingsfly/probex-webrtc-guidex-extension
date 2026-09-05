# GuideX 交互建连延迟 & 迪拜↔利雅得链路分析

> 时间:2026-09-05 · 环境:本机 Chrome 在**迪拜**(ISP: du / AS15802),GuideX 数字人服务在**利雅得**
> 关联指标:`guidex-interaction` 探针的 `click_to_vd_ready_ms` / `click_to_vd_open_ms`

本文记录对 `click_to_vd_ready_ms`(点击触发按钮 → voiceDictation 会话就绪)耗时偏高(最近一小时 200~700ms)的完整排查:从指标语义、插件打点改造,到实际网络链路分析、利雅得侧三角验证、overlay 中转实测、TLS 入口实测,以及最终结论与优化建议。

---

## 1. 背景与目标

- 现象:`click_to_vd_ready_ms` 分布在 **200~700ms**,波动大。
- 目标:定位耗时构成,判断是否合理,给出可行的优化方向。

## 2. 指标语义与打点改造

### 2.1 原始定义
`click_to_vd_ready_ms = tVdReady − tClick`,就绪判定 = 出现新的 voiceDictation WebSocket 且其上已发首帧。

**问题**:旧实现用 **每 100ms 轮询** 判定就绪并在轮询命中时 `performance.now()` 打点 → 引入最多 **+100ms 量化噪声**。

### 2.2 改造(commit `8e6ddc3`)
- `tVdReady` 改为 voiceDictation WS **首帧 `send()` 的事件时间戳**;
- 新增 `tVdOpen` = WS **`open` 事件时间戳**;
- 新增字段 **`click_to_vd_open_ms`**(点击→open = GuideX 点击处理 + 会话/token 请求 + 全新 WSS 握手),把"网络握手"与"应用初始化"拆开。

### 2.3 生产验证(20.4)
reload 后新版本数据:

| 时间 | vd_open | vd_ready | ready−open |
|------|:--:|:--:|:--:|
| 14:03:42 | 153 | 157 | **4ms** |
| 14:04:42 | 348 | 350 | **2ms** |

结论:`ready − open ≈ 2~4ms`(与浏览器实测 open→首帧 send = 3ms 吻合)。即 `click_to_vd_ready` 几乎全在"点击→open"这段;`vd_open` 呈 153ms(纯握手 floor)/ 348ms(握手 + 较慢的会话 API)两类。

## 3. 端点与链路事实

| 对象 | IP | ASN / 归属 | 地理 |
|------|----|-----------|------|
| 本机出口 | 94.204.121.255 | AS15802 du (Emirates Integrated) | 迪拜 UAE |
| GuideX/ASR 端点 `guidex-me.iflyoversea.com` | 80.238.236.76 | **AS136907 Huawei Cloud SA** | **利雅得** |
| 测试用腾讯节点 | 43.164.74.174 | AS132203 Tencent | **利雅得**(与端点同城,直线约 3~4km) |

- voiceDictation WS 实连 `wss://guidex-me.iflyoversea.com/chat/api/voiceDictation/<uuid>/552`,**与主站同一 host**。
- **每轮交互新开一条全新 WSS(零复用)**:采集期间观察到 28 条不同 UUID。
- 路径(traceroute):`du → 在 UAE-IX 交给 STC(AS39386) → 华为云利雅得`。

## 4. 实测数据

### 4.1 迪拜侧握手分段(curl,到华为端点)
DNS ~3ms · **TCP 50ms(=1 RTT≈50ms)** · TLS +55ms · HTTPS ttfb ~150ms。RTT 稳定在 50ms(8/8 一致)→ 固定路径长度问题,非拥塞。

### 4.2 浏览器内真实 WSS 建连(迪拜)
`构造→open = 150ms`(TCP50 + TLS55 + WS Upgrade~50);`open→首帧 send = 3ms`。voiceDictation 之前有 fetch API,TTFB **140~290ms**(会话/token 请求)。

### 4.3 三角验证:腾讯利雅得 → 华为端点(同城)
```
ping RTT = 0.34ms (min 0.289 / max 0.413)
TCP connect ~1ms · TLS ~59ms · HTTPS ttfb ~64ms
```
**关键**:同城 RTT 0.34ms → 端点确在利雅得本地;迪拜那 50ms **100% 是 du→STC 选路,与距离无关**。

同时:同城 RTT≈0 时握手仍 ~60ms,其中 TLS 段 ~59ms → 这 ~60ms 是**华为端点侧的服务端 TLS/网关处理**,与网络无关。

### 4.4 overlay 实测(经腾讯利雅得 SNI 透传中转)
nginx `stream` + `ssl_preread`(TLS 端到端透传,证书仍为真实域名,`ssl_verify_result=0`):

| 路径 | ttfb |
|------|:--:|
| A 直连(du→STC→华为) | ~145ms(5/5 稳定) |
| B 经腾讯 relay 快档(3/5) | **~79ms**(-45%) |
| B 经腾讯 relay 慢档(2/5) | ~152ms(≈直连) |

结论:overlay 快档能把建连近乎砍半,但 **du→腾讯路由双峰(~25ms / ~50ms)**,收益不稳定;且消不掉华为侧 ~57ms 服务端 TLS。

### 4.5 TLS 入口实测(在腾讯建 TLS 终结入口,量 du→腾讯 WSS 建连)
nginx TLS 终结(ECDSA P-256)+ 零依赖 python WS echo。发现 **CentOS 7 OpenSSL 1.0.2 不支持 TLS 1.3**,入口最高 TLS 1.2(多 1 个 RTT)。

| 项 | 快档(常态) | 慢档(偶发) |
|----|:--:|:--:|
| TCP(1 RTT) | 25ms | 51ms |
| TLS(1.2 → 2 RTT) | 52ms | 104-110ms |
| WS Upgrade(1 RTT) | 22-26ms | 51ms |
| **WSS 建连合计** | **~100ms** | ~205ms |

RTT 基准(ping):迪拜→腾讯利雅得 **26.8ms** vs 迪拜→华为 **46.4ms**。

折算同口径(都按 TLS 1.3 / 3 RTT):迪拜→腾讯 ≈ **81ms**,迪拜→华为 ≈ **138ms + 服务端 compute**。

ECDSA 近端入口的 TLS 段纯是 `2×RTT` 网络时间、**crypto≈0** → **反证华为那 ~57ms 是服务端低效(疑似 RSA 证书/慢终结),非必然**。

## 5. `click_to_vd_ready_ms` 耗时拆解(迪拜 ~150~700ms)

| 段 | 耗时 | 性质 | 谁能改 |
|----|------|------|--------|
| 点击→建 socket 间的**会话/token API** | ~140~290ms | 可变,高端主因 | GuideX |
| 全新 WSS 握手(构造→open) | ~150ms | 恒定 | 见下细分 |
| ├─ 网络往返(du→STC→利雅得,2 RTT) | ~90ms | 路由偏长 | du / 端点就近 / 中转 |
| └─ 服务端 TLS(华为端点) | ~57ms | 端点固有低效 | iFlytek / Huawei |
| open→首帧 send | ~3ms | 可忽略 | — |
| ~~旧 100ms 轮询噪声~~ | ~~最多 +100ms~~ | **已消除** | 本次改造 |

**"利雅得应该很近"为何没兑现**:理论直连 RTT ~15ms,实测 46~50ms(3×)。根因是**路由绕行**(du→STC 非最优,同城另一路径 du→腾讯仅 27ms 可证),不是距离。

## 6. 优化方案(按性价比)

| 方案 | 每轮能省 | 可靠性 | 责任方 |
|------|---------|--------|--------|
| **连接/会话复用**(别每轮新建 WSS) | 整段 ~150ms(网络+服务端 TLS 全摊掉) | 高,ROI 最高 | GuideX |
| 端点就近部署到 UAE | 网络 ~90ms | 高 | iFlytek/Huawei |
| 让华为查 TLS 握手为何 ~57ms(换 ECDSA/优化终结) | 服务端 ~57ms(全体受益) | 高 | iFlytek/Huawei |
| 从利雅得侧接入 / TLS 入口 | 握手 150→~100ms(TLS1.3 后 ~81ms) | 中 | 自建 |
| 腾讯利雅得 overlay 中转 | 快档 ~65ms,慢档 0 | 中低(du 选路双峰) | 自建 |
| 压 du 修选路 | 网络 ~20ms(50→30) | 中 | du |

**结论**:最狠的是 **GuideX 端连接复用**(一次摊掉全部握手);网络那 ~90ms 可通过就近/选路/中转压到一半但收益不稳;新发现的**服务端 ~57ms TLS** 是应反馈给 iFlytek/华为的独立问题。

## 7. 测试环境清理

所有测试设施已从腾讯节点(43.164.74.174)拆除并验证:nginx 卸载、443/9001 端口释放、`~/cc-lab` 与自签证书删除、nginx 源移除,节点恢复原状。测试期间产物均隔离在 `~/cc-lab/`,未污染用户根目录。

## 附:复现实验命令要点

```bash
# 迪拜侧握手分段
curl -s -o /dev/null -w "tcp=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s\n" \
  https://guidex-me.iflyoversea.com/ --resolve guidex-me.iflyoversea.com:443:80.238.236.76

# 路径 & ASN
traceroute -a 80.238.236.76
whois -h whois.cymru.com " -v 80.238.236.76"

# 利雅得侧三角验证(在利雅得节点)
ping -c5 80.238.236.76
curl -s -o /dev/null -w "tcp=%{time_connect}s tls=%{time_appconnect}s\n" \
  https://guidex-me.iflyoversea.com/ --resolve guidex-me.iflyoversea.com:443:80.238.236.76
```
