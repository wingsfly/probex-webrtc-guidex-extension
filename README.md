# ProbeX WebRTC + Guidex Chrome Extension

This project is split from the main `probex` repository.

## What it does

- Hooks browser `RTCPeerConnection` stats in page context
- Collects WebRTC quality metrics for Guidex/XRTC scenarios
- Sends probe data to ProbeX backend through extension proxy/fallback logic

## Load in Chrome

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder:
   - `/Users/hjma/workspace/network/probex-webrtc-guidex-extension`

## Key files

- `manifest.json`
- `background.js`
- `content-script.js`
- `injected.js`
- `popup.html` / `popup.js` / `popup.css`

## Notes

- This extension is now maintained as an independent project parallel to `probex`.
- Backend API compatibility still depends on the ProbeX server endpoints.
