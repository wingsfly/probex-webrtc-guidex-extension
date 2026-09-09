# GuideX Runtime v4 adapter

Development branch: `codex/guidex-v4-runtime`. Legacy release branch: `main`.
This branch supports Auto / Runtime v4 / Legacy selection in the popup. There is
no build or dependency-install step for loading the extension.

## Source contract

Reference: `guidex-front-monorepo`, `feature_v4_runtime_refactor`, commit
`a3d6bd28b`, `@guidex/runtime` version `4.0.0`, reviewed 2026-09-09.

- `packages/gx-runtime/src/adapters/guidex/chat-wire.ts`: chat envelope and URL.
- `packages/gx-runtime/src/adapters/guidex/chat-audio-frame-port.ts`: audio upload.
- `packages/gx-runtime/src/adapters/guidex/draft-interaction-port.ts`: text input.
- `packages/gx-runtime/src/adapters/guidex/runtime-wire-codec.ts`: event validation.
- `docs/2026-09-04-GuideX-Runtime-协议-1.0.md`: input/model/avatar lifecycles.

The public page is `/#/interaction-app/:runId`. The chat socket is
`/chat/api/chat/aichain/:instanceId?runId=...` (optional path prefix supported).
The explicit draft `/api/runtime/v1/ws` transport accepts unwrapped inbound
payloads for protocol replay; it is not claimed as a verified production route.
DeviceBridge `/h5`, `/audio` and vendor RTC sockets do not define business rounds.

Messages require `header.version="1.0"`, `header.sendAt`, correct `header.channel`
and `header.context.instanceId`. Each business round additionally needs its own
`sid/cid`. Inbound chat payloads are `payload.data`; outbound payloads are
unwrapped. `instance.ready` means registration only; session readiness requires
`session.started`, `payload.data.ready=true` and a valid sid. `runId`, RTC
sid/requestId and the extension's node_id are not substitutes.

## Load and switch

```bash
git switch codex/guidex-v4-runtime
npm run check
```

1. Reload this extension in `chrome://extensions/`. Its name includes `(GuideX v4)`.
2. Reload GuideX so hooks attach before sockets/PeerConnections are created.
   Updating an already hooked page cannot recover historical messages.
3. Open the popup. Keep Auto or select Runtime v4 and save. Registration should
   appear when `instance.ready` is observed.
4. Perform a voice/text interaction. In ProbeX Results select `guidex-runtime-v4`
   (task `ext_guidex-runtime-v4`), then filter by Agent/Page as usual.
5. For the old release, switch to `main` and reload extension/page. For an older
   GuideX page on this branch, Auto/Legacy uses the existing `guidex-interaction` task.

ProbeX URL and optional Ingest Token keep their popup settings. WebRTC quality
continues under the configured Probe Name. V4 has a separate business schema, so
legacy historical timing columns retain their original meaning.

## Event mapping

| Event | Fields / meaning |
| --- | --- |
| send conversation.user.append | payload.items[].type=audio and nonempty data; first/last PCM upload, frame/byte counts |
| send conversation.user.append | payload.input.type=text; text round starts |
| send guidance.trigger | payload.kind; welcome/invitation/farewell starts |
| event.user_speech_started/stopped | Matching instanceId/sid/cid; server input notifications |
| stt.result | text/isFinal; first nonempty STT and final snapshot, character count only |
| event.stt_revocation | text; corrected snapshot, clears prior final marker |
| nlu.answer | operation=append/replace, text, format, boolean final; empty final append preserves accumulated length |
| nlu.postprocess | status=completed, finalText, format; optional final if model not already complete |
| avatar.speak.started/ended | Business speaking lifecycle; ended without started supports no-speech replies |
| event.cid_end | Independent statistics marker, never a substitute for input/model/avatar end |
| send event.interrupt | Request only, not an interruption confirmation |
| event.interrupted | stages; missing chat stages means nlu/tts/avatar, explicit empty list is a no-op |
| scoped error, session end, socket close | Failed partial observation, no fabricated total latency |

Observations are keyed by physical socket + instanceId + sid + cid. Only observed
outbound inputs create rounds. Late unsolicited replies cannot create new rows;
missing cid never borrows the current round. Reconnect closes partial observations
and starts fresh connection state. Duplicate finals/late postprocess do not rewrite
a completed model.

## Metric meanings

All anchors use local performance.now() at native send/message receipt. sendAt is
validated but never subtracted from the browser clock. These are browser-observed
delays, not server CPU time, one-way network time or acoustic latency. Full field
definitions are maintained in guidex-runtime.js (`schema`).

| Field | Formula / meaning |
| --- | --- |
| ws_connect_ms | Socket creation to open |
| instance_register_ms | instance.open to instance.ready, registration only |
| session_start_ms | session.start to session.started; reused sessions retain setup measurement |
| audio_upload_window_ms | Last minus first audio append, including silence, not decoded duration |
| audio_start_to_first_asr_ms | First audio append to first nonempty STT |
| speech_stop_to_final_asr_ms | Speech-stopped receipt to STT final |
| speech_stop_to_first_answer_ms | Speech-stopped receipt to first nonempty NLU answer |
| speech_stop_to_avatar_start_ms | Speech-stopped receipt to business avatar start |
| final_asr_to_first_answer_ms | STT final to first answer |
| model_complete_ms / answer_stream_ms | Input/first answer to model final |
| avatar_speak_duration_ms | Business speak start to end; null without a start |
| total_interaction_ms / standard latency_ms | Input to all observed input/model/avatar terminal events; complete rounds only |
| observed_ms | Observed window, including failures/timeouts |

Negative cross-stage deltas are retained: streaming STT/answers can arrive before
the input endpoint. Missing anchors are null. Success requires input, model and
avatar terminal events, not merely ASR text. Recognition is separately represented
by asr_final/asr_recognized. Text/guidance do not require an audio endpoint.
The default deadline is 60s and active round limit is 64. completion_reason reports
completed/interrupted/error/timeout/disconnected/session_ended/session_replaced/
instance_closed/capacity. An interruption ends the measurement window but
input_ended=false still means no input endpoint was observed; upload is not altered.

TTS audio now goes from GuideX to Avatar, not H5. Legacy audio_end_to_tts_ms and
tts_to_avatar_speak_ms are unavailable. Vendor vmr_status and shared downlink RMS
cannot reliably identify a v4 cid, so per-turn lip movement, lip sync and audible
playback timings are not claimed. avatar.speak.started does not prove audio is
unmuted/audible. RTP jitter/RTT/bitrate/frame counts and jitter-buffer A/V difference
remain available from the separate WebRTC quality probe.

V4 results retain identifiers, counters and timings, not prompts, transcripts,
answers, Base64 PCM or RTC credentials. Page query strings are removed. Failed
uploads remain queued for retry (100 rows maximum, batches of 20).

## Auto-Test on v4

Choose browser microphone input in the GuideX device assistant. Capture the
enabled microphone button, upload a short sample, then Start. The extension waits
for the application's first audio upload and feeds decoded test audio into its
microphone mixer. GuideX owns session/cid creation, PCM encoding, VAD and endpoints.
No legacy status=2, empty tail, guessed cid or direct chat audio packet is sent.
Click and long-press modes use the Runtime's existing click/Enter-key handlers;
long-press releases Enter when the sample ends.

Each cycle waits for server input endpoint, model final and avatar end. Stop or
failure cancels playback; if the captured toggle is still pressed it invokes that
button's Escape handler to cancel its capture. Overlapping rounds/multiple Runtime sockets stop
the cycle with a status explanation. DeviceBridge audio is passively observable
but not replaced by synthetic audio. Browser injection needs a secure microphone
context (HTTPS or localhost) and microphone permission.

## Validation boundary

npm run check runs syntax, synthetic protocol replay and MAIN-world script
integration checks with simulated native sockets/reporting. These cover readiness,
cross-cid ordering, revocation, streaming finals, interrupt/disconnect/timeouts,
schema/reporting and microphone reuse. They do not prove real backend, physical
microphone/speaker or DeviceBridge behavior. A registered connection/getStats
sample is not a completed voice interaction; record live verification separately.
