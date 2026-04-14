# ProbeX WebRTC + Guidex Chrome Extension

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

| Short Name | Field | Description |
|-----------|-------|-------------|
| Click->VD | `click_to_vd_ready_ms` | Button click to voiceDictation session ready |
| 1st ASR | `audio_start_to_first_asr_ms` | First word latency |
| ASR Tail | `audio_end_to_final_asr_ms` | Speech end to final ASR result |
| Wait TTS | `audio_end_to_tts_ms` | Speech end to TTS synthesis start |
| TTS->Lip | `tts_to_avatar_speak_ms` | TTS event to avatar mouth movement (vmr=1) |
| Avatar Dur | `avatar_speak_duration_ms` | Total avatar speaking wall-clock time |
| TTS Len | `tts_total_duration_ms` | TTS synthesized audio length (raw, ~1.5x playback speed) |
| Lip Move | `lip_move_ms` | Cumulative lip movement duration |
| Lip Sync | `lip_sync_diff_ms` | `actual_audio_duration - lip_move` |
| Wait Play | `audio_end_to_playback_ms` | Speech end to hearing reply audio |
| Play Dur | `actual_audio_duration_ms` | Client-side audio playback duration (AnalyserNode RMS detection) |
| Lip->Play | `vmr_to_actual_audio_ms` | A/V sync: `actualAudioStart - firstVmr1Time`; negative = audio ahead |
| Total | `total_interaction_ms` | End-to-end total time |

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
