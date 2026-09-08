# Bug 报告(致 iFlytek / GuideX):弱网下 voiceDictation 会话挂死、应用卡在"拾音"态不自恢复

> 报告方:ProbeX 自动拨测。环境:GuideX 数字人 `guidex-me.iflyoversea.com`,`displayInstanceId=525`(一体机客户端,弱网接入)。首次观察:2026-09-08 18:55(本地)。

## 1. 摘要

在到 voiceDictation ASR 端点的**弱网(高 RTT / 丢包)**条件下,一次语音会话会**挂住不结束**;此后 GuideX 应用**卡在"拾音/监听"态**——点击触发按钮**不再开启新的 voiceDictation 会话**,且**不会自恢复**,直到**手动刷新页面**。WebRTC 数字人视频流此时仍正常(页面未崩),仅"语音交互"这一路死锁。

## 2. 现象与影响

- 用户视觉:数字人一直停在"拾音"状态,说话无响应。
- 每次触发交互都在 5s 内因"新的 voiceDictation 会话未就绪"而失败;整轮无任何进展。
- **不自恢复**:连续失败会一直持续(我们观察到从 18:55 持续到手动刷新为止,近 1 小时全失败)。

## 3. 证据(拨测数据)

- **成功→失败分界**:最后一次成功 `18:54`;`18:55` 起连续失败。
- **失败发生在最早一步**:每条失败记录里,"点击→voiceDictation WS open""音频注入""ASR 结果"等字段**全部为空** → 说明**新会话根本没建立**,而不是 ASR 没识别。
- **页面仍存活**:同一时段该客户端的 WebRTC 质量探针(getStats)**持续上报**(近 10 分钟 238 条)→ RTC 连接没断、数字人视频在流,**仅 voiceDictation/ASR 交互死锁**。
- **网络背景**:该客户端链路弱——WebRTC RTT 均值 ~81ms、**尖峰 867ms**、视频抖动 19ms、偶发丢包;推测某次会话在弱网下未完成/未关闭而挂住。

## 4. 健康会话的 WS 生命周期(基线,取自网络良好的客户端 523)

```
t=0ms     create   (wss://.../chat/api/voiceDictation/<uuid>/552)
t=452ms   OPEN
t≈?       [客户端流式发送 16k PCM 音频帧,status:1 文本消息]
t=6335ms  recv  header.status=1  action=h5VoiceInput   (中间/首个识别结果)
t=6339ms  recv  header.status=2  action=h5VoiceInput   (最终识别结果)
t=6397ms  CLOSE code=1000 wasClean=true                (拿到最终结果后干净关闭)
→ 下一轮 create 新的 voiceDictation WS,循环正常
```

**关键点:健康会话在收到 `status=2`(最终 ASR)后,voiceDictation WS 以 `code=1000` 干净关闭。** 我们怀疑卡死时**这一步没有发生**(WS 挂着不关 / 异常关闭码 / 从未收到 `status=2`),使应用侧的会话状态无法复位。

## 5. 请协助抓取"卡死会话"的 WS 生命周期

在**卡住的客户端(一体机)**的 GuideX 页面 DevTools Console 里粘贴以下脚本(它只挂监听、不改任何行为),然后**保持运行直到复现卡死**,再把 `window.__vdLife` 的内容导出发我们/GuideX:

```js
(() => {
  window.__vdLife = [];
  const O = window.WebSocket;
  const W = function(u, p){
    const ws = p ? new O(u,p) : new O(u);
    if (typeof u==='string' && u.includes('voiceDictation')) {
      const t0 = performance.now(), uid = (u.split('/voiceDictation/')[1]||'?').slice(0,8);
      const log = e => { const r={uid,t:Math.round(performance.now()-t0),ev:e}; window.__vdLife.push(r); console.log('[VD]',JSON.stringify(r)); };
      log('create rs='+ws.readyState);
      ws.addEventListener('open',  ()=>log('OPEN'));
      ws.addEventListener('error', ()=>log('ERROR'));
      ws.addEventListener('close', e=>log('CLOSE code='+e.code+' clean='+e.wasClean+' reason='+(e.reason||'-')));
      let n=0; ws.addEventListener('message', e=>{ n++; let s='?'; try{const m=JSON.parse(e.data); s='status='+m?.header?.status+' action='+(m?.header?.action||'');}catch{} if(n<=8) log('recv#'+n+' '+s); });
    }
    return ws;
  };
  W.prototype=O.prototype; ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k=>W[k]=O[k]);
  Object.keys(O).forEach(k=>{try{W[k]=O[k]}catch{}});
  window.WebSocket=W;
  console.log('[VD] lifecycle capture installed — 复现卡死后执行 copy(JSON.stringify(window.__vdLife))');
})();
```

复现卡死后,预期能看到以下之一(正是要给 GuideX 定位的):
- 上一会话的 WS **无 CLOSE**(一直 open),或 **CLOSE code≠1000**(异常关闭);
- **从未收到 `status=2`**(最终 ASR 丢失);
- 点击触发后**没有新的 `create`**(应用不再开新会话)。

## 6. 复现条件

- 到 voiceDictation ASR 端点的链路存在**高 RTT / 抖动 / 丢包**(可用弱网工具人为注入 delay+loss 复现,如 Network Link Conditioner / `tc netem`)。
- 在此条件下反复发起语音交互,直至某次会话挂住、应用卡在监听态。

## 7. 根因假设与修复建议(应用/后端侧)

**假设**:voiceDictation 会话缺少超时/异常兜底——弱网下会话未能正常收到 `status=2` 或未正常关闭时,应用侧的"会话进行中/监听中"状态无法复位,后续触发被这个残留状态挡住。

**建议**:
1. **会话看门狗**:开始拾音后 N 秒内未收到最终结果(`status=2`)或 WS 停滞,则**主动关闭会话并复位到 idle**。
2. **新触发可抢占**:再次点击触发时,**强制中止/替换**任何未完成的旧会话,不被残留状态阻塞。
3. **WS 异常优雅处理**:voiceDictation WS 在丢包下 `close/error` 时,清理会话状态而非静默卡死。
4. **用户可见反馈**:超时/失败时给出错误或自动重试提示,不要停在"拾音"无反馈。

## 8. 客户端侧临时兜底(已在我方 ProbeX 插件实现)

我方已加入自愈:**连续 3 轮"会话未就绪"失败即 `location.reload()`** 复位页面,使自动监控不至于长时间空跑。这是止血,不是根治——根因仍需 GuideX 按 §7 处理(好网络也可能偶发)。
