# Changelog

All notable changes to this project will be documented in this file.

## [1.1.5] - Unreleased

### Fixed
- Treat confirmed normal `presence_left` session closure as success, retaining `completion_reason=session_ended`. Match end requests and confirmations on the same socket, instance and session; explicit server reasons override the request. Errors, timeouts, disconnects and unclassified endings remain failures.
- Keep observed milestones and elapsed observation time without inventing model/playback completion. Successful session closures leave `total_interaction`/standard latency null and are excluded from the matching ProbeX timing charts and bucket averages, not from details or raw exports.
- No historical failure reinterpretation, new display fields, automatic cleanup, deployment or Chrome/page reload is performed by this source change. The companion ProbeX backend and frontend both need deployment.

## [1.1.4] - Unreleased

### Changed
- Remove Runtime v4 `audio_start_to_speech_started` (`Audio_To_Speech`) from registration, reporting, and the matching ProbeX charts/table/export. Retain the independent `Speech_Started` milestone and its event observation.
- Shorten answer/playback duration labels to `Answer_Dur` and `Play_Dur`. Preserve `answer_stream` / `avatar_speak_duration` data keys, formulas, units, and missing-value behavior.
- Update current field documentation and regression coverage. This source change does not deploy ProbeX, reload Chrome/GuideX, or clean remote history; legacy adapters remain unchanged.

## [1.1.3] - Unreleased

### Changed
- Replace Runtime v4 speech-stop-based intervals with `last_audio_to_final_asr`, `last_audio_to_first_answer`, and `last_audio_to_avatar_start`, displayed as `LastAudio_To_STT`, `LastAudio_To_Answer`, and `LastAudio_To_Play`.
- Anchor all three intervals to the last successful audio append of the same turn. Preserve signed deltas and null for missing endpoints; never fall back to speech-stop, first input, or sample end.
- Remove `test_audio_to_avatar_start` (`Test_To_Play`) and its unused sample-end annotation. Auto-tests use the same `LastAudio_To_Play` metric as passive audio.
- Update the matching ProbeX charts, table/export filtering, docs, and replay/MAIN regression tests. Legacy is unchanged. Reload extension and GuideX page before collecting the new fields; this source update is not a deployment or historical cleanup.

## [1.1.2] - Unreleased

### Changed
- Remove numeric prefixes from Runtime v4 labels and registration descriptions. Use `_To_` between duration endpoints, retain `1st`, and keep business sorting separate from display names. Stored keys, measurements, and history are unchanged.
- Use 14 ordered English Runtime v4 milestone labels and English display values in the matching ProbeX UI.
- Remove the implicit zero-valued `start`; replace `mic_request/mic/ready` with `mic_ready` (observed UI readiness relative to `start_at`, not a sum or estimate).
- Keep `start_at/start_by/press_kind/input_source` as unnumbered origin metadata. Legacy support is unchanged.
- Replace STT character/status fields with the current `stt_text` snapshot alongside `Last_STT`; remove redundant audio size, upload-window, input/model-status and derived duration fields from Runtime v4.
- Observe `Mic_Ready` in portrait waveform state or non-portrait `aria-busy=false` state after native microphone acquisition.
- Move the matching ProbeX turn timeline below the results table and pagination; order trend legends and tooltips by business stage.
- Update Chinese field documentation and cover missing/zero microphone readiness. Reload both extension and GuideX page after installing; fields remain not finalized.

## [1.1.1] - 2026-09-10

### Fixed
- Versioned, single-instance reporting bridge; invalidated listeners retire silently and cannot trigger a competing page POST.
- Select direct transport only before dispatch; proxy errors/timeouts never start a second transport for the same attempt.
- Stable per-sample `result_id` across WebRTC, Legacy and Runtime retries, with bounded queues and one in-flight push per probe.
- Popup warning when the page still runs the pre-fix collector. Requires extension and page reload; backend idempotency support is required for uncertain-outcome retries.
- Regression coverage for stale listeners, duplicate injections, delayed responses, retries and identity changes.

## [Unreleased]

### Added
- Old-turn interrupt request/confirmation offsets, wall timestamps and acknowledgement latency.
- Runtime DOM audio-source identification, trusted microphone press timestamps and internal acquisition/UI-ready observations.
- Ordered per-turn timeline offsets with explicit user-press, auto-test or first-input origins.
- Gesture cancellation/isolation tests and a matching ProbeX `codex/guidex-v4-timeline` chart branch.

### Changed
- Unified turn origins as `start_at/start_by`, removed `_ms` from custom duration fields, and grouped metric descriptions by business-stage number.
- Removed `protocol_profile/source_evidence` from registrations and results; ProbeX uses only the current v4 field names without historical alias conversion or milestone reconstruction.
- Marked v4 fields as not finalized: clear obsolete v4 test history during schema iteration, then preserve history after explicit user sign-off; no scheduled or startup deletion.
- Confirmed Runtime interruptions count as successful settlement with an explicit `interrupted` reason; natural playback endpoints remain factual.
- Runtime v4 passive capture returns the native microphone stream without the auto-test mixer; synthetic tests retain injection and cleanup.
- Runtime v4 no longer registers or reports shared connection/session timing fields (`ws_connect_ms`, `instance_register_ms`, `session_start_ms`) on individual turns.
- Expanded Chinese adapter documentation with microphone gesture and business speech-event boundaries.
- Keep remaining stage-duration fields as hidden diagnostics; passive Runtime microphone failures now propagate to the application.

## [1.1.0] - 2026-09-09

### Added
- GuideX Runtime v4 observer with a separate probe/schema and per-socket instance/sid/cid tracking.
- Independent input/model/avatar timing, partial failures, popup protocol selection and status.
- Runtime auto-test through the application's own microphone/session/cid pipeline.
- Synthetic replay and MAIN script integration checks (`npm run check`).
- Version switching and metric definitions in `docs/guidex-runtime-v4.md`.

### Fixed
- Reusable microphone mixer tracks across successive capture cycles.
- Passive business monitoring without the secure-context microphone API.
- Preserve captured target origin when toggling automatic tests.

## [0.1.0] - 2026-04-14

### Added
- Initial standalone project split from `probex`.
- Chrome extension files for WebRTC + Guidex interaction:
  - `manifest.json`
  - `background.js`
  - `content-script.js`
  - `injected.js`
  - `popup.html`, `popup.js`, `popup.css`
  - `icons/`
- Project documentation in `README.md`.
- Base ignore rules in `.gitignore`.

### Notes
- This extension remains API-compatible with ProbeX backend endpoints.
