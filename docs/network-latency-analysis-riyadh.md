# GuideX 交互建连延迟 & 迪拜↔利雅得链路分析

> 时间:2026-09-05 · 环境:本机 Chrome 在**迪拜**(ISP: du / AS15802),GuideX 数字人服务在**利雅得**
> 关联指标:`guidex-interaction` 探针的 `click_to_vd_ready_ms` / `click_to_vd_open_ms`

本文记录对 `click_to_vd_ready_ms`(点击触发按钮 → voiceDictation 会话就绪)耗时偏高(最近一小时 200~700ms)的完整排查:指标语义、插件打点改造、网络链路逐跳分析、利雅得侧三角验证、overlay 中转实测、TLS 入口实测,以及最终结论与优化建议。

> **重要更正(相对初版)**:初版曾把握手拆成"~90ms 网络 + ~57ms 服务端 TLS"。经复核,那 ~57ms 是**测量假象**——利雅得侧探测用的是腾讯 CentOS 7 上的 OpenSSL 1.0.2(只能 TLS 1.2)老客户端,其 ~58ms 主要是老库/RSA 处理开销,并非华为网关延迟。从迪拜 macOS(TLS 1.3)干净测量看,**~150ms 全新握手 ≈ 3 个网络 RTT**,是纯网络往返,无显著服务端计算。见 §4.3、§5。

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

## 3. 端点与身份事实

| 对象 | IP | ASN / 归属 | 地理 |
|------|----|-----------|------|
| 本机出口 | 94.204.121.255 | **AS15802 du**(Emirates Integrated Telecom) | 迪拜 UAE |
| GuideX/ASR 端点 `guidex-me.iflyoversea.com` | 80.238.236.76 | **AS136907 Huawei Cloud SA**(BGP 前缀 80.238.224.0/20) | **利雅得** |
| 测试用腾讯节点 | 43.164.74.174 | **AS132203 Tencent** | **利雅得**(与端点同城,直线约 3~4km) |

- voiceDictation WS 实连 `wss://guidex-me.iflyoversea.com/chat/api/voiceDictation/<uuid>/552`,**与主站同一 host**(同一 IP、同一 RTT)。
- **每轮交互新开一条全新 WSS(零复用)**:采集期间观察到 28 条不同 UUID。
- ASN 用 Team Cymru `whois -h whois.cymru.com` 查得;地理用 ip-api 交叉核对,两端点均落 Riyadh。

## 4. 链路路径详解(本节为本文重点)

### 4.1 迪拜 → 华为端点(80.238.236.76)的实际路径

`traceroute -a` 原始输出:

```
 1  [AS0]     192.168.70.1                                           1.3 ms   本地网关(办公室)
 3  [AS0]     10.100.137.21                                          3.9 ms   du 城域网/CGNAT(私网地址)
 4  [AS0]     10.100.34.78                                           5.0 ms   du 骨干
 7  [AS0]     ipv4.uae-ix.secondlink.dxb.ae.as39386.stc.com.sa      62.8 ms   ★ UAE-IX(迪拜交换中心)上的 STC 路由器
 9  [AS39386] 84-235-94-223.saudi.net.sa                            76.2 ms   STC 沙特骨干(saudi.net.sa)
10+ * * *                                                                     ICMP 被过滤(进入 STC/华为内网后不可见)
```

**逐跳解读**:
1. **hop 1–4(~5ms)**:流量在 **du(AS15802)** 自己的城域网/骨干内,还在迪拜。
2. **hop 7**:du 把流量**在 UAE-IX(迪拜互联网交换中心,peering LAN `185.1.8.0/24`)交给 STC(AS39386,沙特电信)** 的路由器 `185.1.8.30`。这台机器名 `...dxb.ae.as39386.stc.com.sa` 明确是 STC 放在迪拜的对等设备。
3. **hop 9**:进入 **STC 沙特骨干**(`saudi.net.sa`),由 STC 把流量载往利雅得。
4. **hop 10 之后**:ICMP 被过滤,看不到进入 STC/华为云内部的具体跳(华为云沙特 Region 建在 STC 基础设施上,AS136907 经 STC 可达)。

**AS 路径**:`du(AS15802) → [UAE-IX] → STC(AS39386) → Huawei Cloud SA(AS136907)`。

**关于时延的正确读法**:
- traceroute 里 hop 7 显示 62ms、hop 9 显示 76ms,但**这些是被路由器 ICMP 限速抬高的显示值,不可作为链路 RTT**。
- **权威值是 TCP 握手时间**:`exec 3<>/dev/tcp/80.238.236.76/443` 实测 **50ms(多次 50/50/60)**;`ping` 实测 **avg 46.4ms**。所以到端点的真实 RTT ≈ **46~50ms**。

### 4.2 迪拜 → 腾讯利雅得(43.164.74.174)的路径(对照组)

```
 1  192.168.70.1              1.3 ms   本地网关
 3  10.100.136.94             4.0 ms   du 城域网
 4  10.100.35.78              7.2 ms   du 骨干
 7  itc2.uae-ix.net (185.1.8.85)  19.4 ms   ★ UAE-IX 上另一对等(非 STC)
19  28.34.146.198             28.8 ms   Tencent 侧
20  29.180.70.33             25.4 ms   Tencent 内网
```

到腾讯利雅得的 RTT(ping)= **26.8ms**。同样从 du 出、同样经 UAE-IX,但**在交换中心把流量交给了不同的对等方**(`itc2.uae-ix.net`,而非 STC),走的是另一条到利雅得的路。

### 4.3 反向:腾讯利雅得 → 华为端点(同城,证明端点确在本地)

```
 1  29.180.70.33     0.3 ms
 2  28.34.146.198    0.4 ms
 5  103.117.52.173   2.9 ms
 7  172.16.167.26    0.8 ms
 8  10.160.136.80    0.4 ms
 9  10.160.136.17    0.4 ms   (进入华为内网)
ping RTT = 0.34 ms (min 0.289 / max 0.413)
```

同城 RTT **0.34ms** → **端点确在利雅得本地**(几乎同机房级)。

> ⚠️ 在这台腾讯节点上用 curl 测到华为端点的 HTTPS 握手时,TLS 段显示 ~58ms(RTT 才 0.3ms)。这**不是华为服务端延迟**,而是该节点 **CentOS 7 的 OpenSSL 1.0.2 只能 TLS 1.2、且做 RSA 处理慢**造成的老客户端开销。用现代 TLS 1.3 客户端(迪拜 macOS)测同一端点,TLS 段就是干净的 1 个 RTT(见 §5),无此额外开销。**本节唯一可信结论是 RTT 0.34ms(端点在本地)。**

### 4.4 为什么"同在利雅得",迪拜到两者却差 46 vs 27ms?

同为 du 出口、同过 UAE-IX,差别在**交换中心的下一跳对等选择**:
- **到华为端点**:交给 **STC(AS39386)**,由 STC 网络载往利雅得 → **~50ms**。STC 这条路径明显比直线更长(利雅得-迪拜直线理论 RTT ~15ms)。
- **到腾讯利雅得**:交给 **itc2/Tencent 一侧** → **~27ms**。

所以那多出来的 ~20~30ms **是 du→STC 这条路由绕行造成的,与物理距离无关**——同城的腾讯节点用另一条路只要 27ms 就是证据。

## 5. 握手耗时的正确拆解(迪拜 macOS,TLS 1.3,权威口径)

直连华为端点的 curl 分段(macOS,TLS 1.3):

| 段 | 实测 | 对应 |
|----|:--:|----|
| TCP 握手(`time_connect`) | 47ms | 1 RTT |
| TLS 握手(`appconnect − connect`) | 50ms | 1 RTT(TLS 1.3,服务端计算可忽略) |
| HTTP 请求/响应(`ttfb − appconnect`) | 46ms | 1 RTT |
| **HTTPS ttfb 合计** | **~143ms** | **3 RTT** |

浏览器内实测**全新 WSS 建连 = 150ms**(TCP + TLS + WS Upgrade = 3 RTT),与上表一致。

**结论:`click_to_vd_open_ms` 的 ~150ms floor ≈ 3 个网络 RTT × ~50ms**,是**纯网络往返**,没有显著服务端 TLS 计算(初版的"~57ms 服务端 TLS"已更正为测量假象)。

`click_to_vd_ready_ms`(迪拜 ~200~700ms)完整构成:

| 段 | 耗时 | 性质 | 谁能改 |
|----|------|------|--------|
| 点击→建 socket 间的**会话/token API**(1+ 次 HTTP 往返) | ~140~290ms | 可变,高端主因 | GuideX |
| 全新 WSS 握手(TCP+TLS+WS Upgrade = 3 RTT) | ~150ms | 由 RTT 决定 | 见下 |
| ├─ RTT 本身(du→STC→利雅得) | ~50ms/RTT | 路由绕行(可优化到 ~27ms) | du / 端点就近 / 中转 |
| └─ 往返次数(3 次) | ×3 | 每轮新建连接所致 | 连接复用 / 0-RTT |
| open→首帧 send | ~3ms | 可忽略 | — |
| ~~旧 100ms 轮询噪声~~ | ~~最多 +100ms~~ | **已消除** | 本次改造 |

## 6. overlay / TLS 入口实测

### 6.1 overlay(经腾讯利雅得 SNI 透传,TLS 端到端)
nginx `stream` + `ssl_preread`,证书仍为真实域名(`ssl_verify_result=0`):

| 路径 | ttfb |
|------|:--:|
| A 直连(du→STC→华为) | ~145ms(5/5 稳定) |
| B 经腾讯 relay 快档(3/5) | **~79ms**(-45%) |
| B 经腾讯 relay 慢档(2/5) | ~152ms(≈直连) |

快档 ~79ms ≈ 3×27ms(经腾讯 RTT),但 **du→腾讯路由双峰(~25 / ~50ms)**,收益不稳。

### 6.2 TLS 入口(在腾讯建 TLS 终结入口,量 du→腾讯 WSS 建连)
nginx TLS 终结(ECDSA P-256)+ 零依赖 python WS echo。**CentOS 7 OpenSSL 1.0.2 不支持 TLS 1.3**,入口最高 TLS 1.2(多 1 个 RTT)。

| 项 | 快档(常态) | 慢档(偶发) |
|----|:--:|:--:|
| TCP(1 RTT) | 25ms | 51ms |
| TLS(1.2 → 2 RTT) | 52ms | 104-110ms |
| WS Upgrade(1 RTT) | 22-26ms | 51ms |
| **WSS 建连合计** | **~100ms** | ~205ms |

- 折算 TLS 1.3(3 RTT):迪拜→腾讯 ≈ **~81ms** vs 迪拜→华为 ≈ **~138ms**。
- 该入口 ECDSA 的 TLS 段纯是 `2×RTT` 网络时间、**crypto≈0**,进一步佐证 §5:握手成本在网络 RTT,不在加密计算。

## 7. 优化方案(按性价比)

| 方案 | 每轮能省 | 可靠性 | 责任方 |
|------|---------|--------|--------|
| **连接/会话复用**(别每轮新建 WSS) | 整段 ~150ms(3 RTT 全摊掉) | 高,ROI 最高 | GuideX |
| **TLS 会话恢复 / 0-RTT**(复用不可行时) | 1 个握手 RTT | 高 | GuideX/端点 |
| 端点就近部署到 UAE | 每 RTT 从 50→~5ms | 高 | iFlytek/Huawei |
| 压 du 修选路(避开 STC 绕行) | 每 RTT 50→~27ms | 中 | du |
| 从利雅得侧接入 / 自建 TLS 入口 | 握手 150→~100ms(TLS1.3 后 ~81ms) | 中 | 自建 |
| 腾讯利雅得 overlay 中转 | 快档 ~65ms,慢档 0 | 中低(du 选路双峰) | 自建 |

**结论**:握手成本 = **往返次数 × RTT**。
- **减往返次数**:连接复用是最优解(一次摊掉 3 个 RTT);其次 TLS 0-RTT/会话恢复。
- **减 RTT**:端点就近 UAE 最彻底;压 du 选路 / 走利雅得中转能把 50ms→~27ms,但收益不稳。
- 新发现的服务端开销**不存在**(初版已更正),因此无需在端点 TLS 上找问题;真正杠杆是"少建连 + 缩 RTT"。

## 8. 测试环境清理

所有测试设施已从腾讯节点(43.164.74.174)拆除并验证:nginx 卸载、443/9001 端口释放、`~/cc-lab` 与自签证书删除、nginx 源移除,节点恢复原状。测试期间产物均隔离在 `~/cc-lab/`,未污染用户根目录。

## 附:复现实验命令要点

```bash
# 迪拜侧握手分段(现代 TLS 1.3,权威)
curl -s -o /dev/null -w "tcp=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s\n" \
  https://guidex-me.iflyoversea.com/ --resolve guidex-me.iflyoversea.com:443:80.238.236.76

# 真实 RTT(TCP 握手,规避 ICMP 限速)
for i in 1 2 3; do { /usr/bin/time -p bash -c "exec 3<>/dev/tcp/80.238.236.76/443"; } 2>&1 | awk '/real/{print $2*1000"ms"}'; done

# 路径 & ASN
traceroute -a 80.238.236.76
whois -h whois.cymru.com " -v 80.238.236.76"

# 利雅得侧三角验证(在利雅得节点)
ping -c5 80.238.236.76
```
