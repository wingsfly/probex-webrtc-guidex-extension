# Changelog

All notable changes to this project will be documented in this file.

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
