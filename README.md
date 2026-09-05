# ProbeX WebRTC + Guidex Chrome Extension

> English | [中文](README.zh.md)

Chrome MV3 extension for monitoring WebRTC audio/video quality metrics on browser pages, with specialized support for iFlytek Guidex digital human interaction testing.

## Features

### WebRTC Quality Monitoring
- Hook `RTCPeerConnection.getStats()` to collect inbound-rtp, outbound-rtp, candidate-pair statistics
- 500ms sub-sampling with 2s max-aggregated push to ProbeX backend
- Metrics: latency, jitter (audio/video), packet loss, bitrate (up/down), jitter buffer delay
- Cross-PC jitter buffer aggregation (Guidex uses separate PeerConnections for audio and video)

### Guidex Interaction Probe (Auto-Test)
- **Element Capture**: click any page element to use as the test trigger button
- **Audio Injection**: upload WAV/MP3 test audio, injected directly via voiceDictation WebSocket as 16kHz 16-bit PCM frames
- **Web Worker Timer**: accurate 40ms audio frame pacing even when the browser tab is hidden (remote desktop disconnect scenario)
- **End-to-End Timing**: 18+ metrics covering the full interaction lifecycle

### Interaction Timing Metrics

Reported under the `guidex-interaction` probe, one row per auto-test cycle.
Metrics are grouped along the interaction lifecycle. Per-metric deep-dives live
in [docs/interaction-metrics-analysis.md](docs/interaction-metrics-analysis.md);
the Dubai↔Riyadh link + `click_to_vd_ready_ms` study is in
[docs/network-latency-analysis-riyadh.md](docs/network-latency-analysis-riyadh.md). A field is `null` when its
event never fired (e.g. every downlink metric is null when ASR fails), which is
the primary failure signal.

**Timeline anchors** (all marked in-page by the extension):

| Anchor | When |
|--------|------|
| `tClick` | Trigger button clicked (interaction start) |
| `tVdOpen` | voiceDictation WebSocket `open` event (handshake done) |
| `tVdReady` | First frame sent on the voiceDictation WS (session ready) |
| `tAudioStart` / `tAudioEnd` | Injected test audio start / end ("user speaking") |
| `firstAsrTime` / `finalAsrTime` | First ASR word / final ASR result returned |
| `ttsStartTime` | First TTS synthesis event (autoReport WS `textChat` + `isAudioDriver`) |
| `firstVmr1Time` | Avatar mouth starts moving (`vmr_status=1`) |
| `actualAudioStart` / `actualAudioEnd` | Client actually hears reply audio start / end (AnalyserNode RMS) |

**Status / identity**

| Field | Meaning |
|-------|---------|
| `success` | Whether speech was recognized (`firstAsrText` non-empty) |
| `asr_text` | Recognized text (final result, falls back to first word) |
| `audio_duration_ms` | Raw duration of the injected test audio (decoded WAV) |
| `page_url` | Page URL where the interaction ran |
| `cycle` | Auto-test cycle number |

**Uplink — click → speak → recognize**

| Short Name | Field | Formula | Description |
|-----------|-------|---------|-------------|
| Click->Open | `click_to_vd_open_ms` | `tVdOpen − tClick` | Click to voiceDictation WS **open** — GuideX click handler + any session/token API + fresh WSS handshake (TCP+TLS+WS upgrade) |
| Click->VD | `click_to_vd_ready_ms` | `tVdReady − tClick` | Click to first frame sent on the WS (session ready). `ready − open` = app init after open (~few ms) |
| 1st ASR | `audio_start_to_first_asr_ms` | `firstAsrTime − tAudioStart` | First-word latency |
| ASR Tail | `audio_end_to_final_asr_ms` | `finalAsrTime − tAudioEnd` | Speech end to final ASR result |

> `tVdOpen` / `tVdReady` are stamped from the WS `open` event and the first
> `send()` on it (event-based), not a poll — so the metric carries no polling
> quantization. A fresh voiceDictation WSS is opened **per cycle** (no reuse), so
> `click_to_vd_open_ms` is dominated by the handshake round-trips to the endpoint.

**Downlink — understand → synthesize → avatar speaks**

| Short Name | Field | Formula | Description |
|-----------|-------|---------|-------------|
| Wait TTS | `audio_end_to_tts_ms` | `ttsStartTime − tAudioEnd` | Speech end to first TTS event (incl. LLM think time) |
| TTS->Lip | `tts_to_avatar_speak_ms` | `firstVmr1Time − ttsStartTime` | TTS event to avatar mouth movement |
| Wait Play | `audio_end_to_playback_ms` | `actualAudioStart − tAudioEnd` | Speech end to actually hearing reply (subjective wait) |

**Playback / lip-sync**

| Short Name | Field | Formula | Description |
|-----------|-------|---------|-------------|
| Play Dur | `actual_audio_duration_ms` | `actualAudioEnd − actualAudioStart` | Client-side reply-audio playback duration (RMS) |
| Avatar Dur | `avatar_speak_duration_ms` | `avatarSpeakEnd − avatarSpeakStart` | Total avatar speaking wall-clock time |
| Lip Move | `lip_move_ms` | Σ(`vmr` 1→2) | Cumulative time the mouth is actually moving |
| Lip Sync | `lip_sync_diff_ms` | `actual_audio_duration − lip_move` | >0 = audio plays longer than the mouth moves |
| Lip->Play | `vmr_to_actual_audio_ms` | `actualAudioStart − firstVmr1Time` | A/V sync; negative = audio ahead of lips |

**Total**

| Short Name | Field | Formula | Description |
|-----------|-------|---------|-------------|
| Total | `total_interaction_ms` | `actualAudioEnd − tClick` (falls back to avatarSpeakEnd → ttsStart → finalAsr) | End-to-end: click to reply-audio playback end |

### WebRTC Quality Metrics (Guidex Sim)

Sampled browser-side from `RTCPeerConnection.getStats()` every push interval
(default 2s) and reported under the `Guidex Sim` probe. Fields marked *hidden*
carry `default_hidden` in the output schema (off by default in the chart, still
toggleable in the legend).

| Field | Description | getStats source |
|-------|-------------|-----------------|
| `latency_ms` | End-to-end round-trip time (ms) | `remote-inbound-rtp.roundTripTime`×1000 (fallback candidate-pair RTT) |
| `packet_loss_pct` | Packet loss (%) | packetsLost / (packetsReceived + packetsLost) delta ×100 |
| `download_bps` | Inbound bitrate | inbound-rtp `bytesReceived` delta ×8 / interval |
| `upload_bps` | Outbound bitrate | outbound-rtp `bytesSent` delta ×8 / interval |
| `audio_jitter` | Audio RTP interarrival jitter (ms) | inbound-rtp(audio) `jitter`×1000 |
| `video_jitter` | Video RTP interarrival jitter (ms) | inbound-rtp(video) `jitter`×1000 |
| `video_fps` | Video frame rate (fps) | inbound-rtp(video) `framesPerSecond` |
| `video_frames_decoded` *hidden* | Frames decoded per push interval (≈ `video_fps` × interval, e.g. ~50 at 25fps / 2s) | inbound-rtp(video) `framesDecoded` delta, summed over the window |
| `video_frames_dropped` *hidden* | Frames dropped per push interval (0 when healthy) | inbound-rtp(video) `framesDropped` delta, summed over the window |
| `audio_jb_delay_ms` | Audio jitter-buffer playout delay (ms) | (`jitterBufferDelay` delta / `jitterBufferEmittedCount` delta)×1000 |
| `video_jb_delay_ms` | Video jitter-buffer playout delay (ms) | same, video inbound-rtp |
| `av_sync_diff_ms` | A/V sync: latest videoJB − audioJB (ms) | >0 = video lags audio |
| `available_outgoing_bitrate` *hidden* | Estimated available upload bandwidth (bps) | candidate-pair `availableOutgoingBitrate` |
| `connection_count` *hidden* | Active PeerConnection count | number of tracked PCs |
| `quality_limitation` | Encoder quality-limitation reason | outbound-rtp(video) `qualityLimitationReason` (cpu/bandwidth/none) |
| `page_url` | Source page URL | `location.href` |

> Note: avatar audio and video ride on **separate PeerConnections**, so each
> 500ms sub-sample only carries one side's inbound-rtp fields. The extension
> merges fields across the 2s window so both are reported — point-in-time fields
> (`video_jitter`/`video_fps`/`*_jb_delay_ms`) take the latest non-null value,
> while the additive frame counts `video_frames_decoded`/`_dropped` are **summed**
> across the window (true per-interval count). An audio-PC sub-sample leaves the
> video fields null (not 0) so it can't clobber the video PC's values.
> `video_fps` is the live decode rate from getStats.

## Architecture

```
┌─────────────┐    postMessage    ┌──────────────────┐    fetch proxy    ┌──────────────┐
│  popup.html  │ ◄──────────────► │  content-script   │ ◄──────────────► │ background.js │
│  (config UI) │                  │  (bridge layer)   │                  │ (Service Worker)│
└─────────────┘                  └──────────────────┘                  └──────────────┘
                                         ▲
                                         │ postMessage
                                         ▼
                                 ┌──────────────────┐      HTTP POST     ┌──────────┐
                                 │   injected.js     │ ─────────────────► │  ProbeX   │
                                 │  (MAIN world)     │                    │  Server   │
                                 │  - WebRTC hooks   │                    └──────────┘
                                 │  - WS hooks       │
                                 │  - Audio injection │
                                 │  - Stats collector │
                                 └──────────────────┘
```

- **injected.js**: Runs in page MAIN world. Hooks `RTCPeerConnection`, `WebSocket`, `getUserMedia`. Contains all measurement logic. Survives SES (Secure EcmaScript) lockdown via periodic re-application.
- **content-script.js**: Bridge between chrome.storage config and injected.js. Proxies fetch requests through background SW for mixed content (HTTPS page -> HTTP ProbeX).
- **background.js**: Lightweight Service Worker for popup queries, fetch proxy, and re-injection on update.
- **popup.html/js/css**: Configuration UI with auto-test panel (capture button, audio upload, interval config, start/stop).

## Installation

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder

## Configuration (via popup)

- **ProbeX URL**: HTTP endpoint for pushing metrics (e.g. `http://your-server:8080`)
- **Push Interval**: Stats aggregation window (default 2s)
- **Auto-Test**: Capture a page button, upload test audio, set interval, start cycling

## Test Audio

The `audio/` directory contains sample WAV files for auto-test:
- `hello_introduce.wav` - Basic greeting test audio

## Notes

- The extension bypasses SES lockdown (used by iFlytek XRTC SDK) with periodic hook re-application
- Audio injection sends PCM frames directly to voiceDictation WebSocket, bypassing getUserMedia/MediaRecorder
- Web Worker timer ensures accurate 40ms frame pacing even with hidden/background tabs
- Stats push uses background SW fetch proxy to bypass mixed content restrictions, with direct fetch fallback
