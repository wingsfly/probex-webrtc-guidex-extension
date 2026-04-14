// ProbeX WebRTC Monitor - Popup UI
'use strict';

const $ = (id) => document.getElementById(id);

const DEFAULT_CONFIG = {
  hubUrl: 'http://localhost:8080',
  probeName: 'webrtc-browser',
  agentId: '',
  collectInterval: 2000,
  pushInterval: 5000,
  enabled: true,
};

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('probexConfig', (stored) => {
      resolve({ ...DEFAULT_CONFIG, ...stored.probexConfig });
    });
  });
}

function updateConfigForm(config) {
  $('hubUrl').value = config.hubUrl || '';
  $('probeName').value = config.probeName || '';
  $('agentId').value = config.agentId || '';
  $('collectInterval').value = (config.collectInterval || 2000) / 1000;
  $('pushInterval').value = (config.pushInterval || 5000) / 1000;
  $('enabled').checked = config.enabled !== false;
}

// Query injected.js in the active tab for live stats
async function queryActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try { return window.__probexStats ? window.__probexStats() : null; }
        catch (e) { return null; }
      },
      world: 'MAIN',
    });
    return results?.[0]?.result || null;
  } catch (e) {
    return null;
  }
}

function updateStatus(config, liveStats) {
  const badge = $('statusBadge');

  if (!config.enabled) {
    badge.textContent = 'Disabled';
    badge.className = 'status-badge disabled';
    return;
  }

  if (liveStats) {
    badge.textContent = 'Active';
    badge.className = 'status-badge connected';
    $('connCount').textContent = liveStats.connections || 0;
    $('pushOk').textContent = liveStats.pushOk || 0;
    $('pushFail').textContent = liveStats.pushFail || 0;

    if (liveStats.lastPushAt) {
      const ago = Math.round((Date.now() - liveStats.lastPushAt) / 1000);
      $('lastPush').textContent = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    }

    const m = liveStats.latest;
    if (m) {
      setMetric('metricRtt', m.latencyMs, 'ms', 0, [100, 300]);
      setMetric('metricJitter', m.audioJitter, 'ms', 1, [30, 80]);
      setMetric('metricLoss', m.packetLossPct, '%', 2, [1, 5]);
      setMetric('metricDown', m.downloadBps != null ? m.downloadBps / 1000 : null, 'kbps', 0);
      setMetric('metricUp', m.uploadBps != null ? m.uploadBps / 1000 : null, 'kbps', 0);
      setMetric('metricFps', m.videoFps, 'fps', 0);
    }
  } else {
    badge.textContent = 'No Data';
    badge.className = 'status-badge disconnected';
  }
}

function setMetric(id, value, unit, decimals, thresholds) {
  const el = $(id);
  if (value == null) { el.textContent = '--'; el.className = 'metric-value'; return; }
  el.textContent = `${value.toFixed(decimals)} ${unit}`;
  el.className = 'metric-value';
  if (thresholds) {
    if (value >= thresholds[1]) el.className = 'metric-value bad';
    else if (value >= thresholds[0]) el.className = 'metric-value warn';
  }
}

function onSave() {
  const newConfig = {
    hubUrl: $('hubUrl').value.trim().replace(/\/+$/, ''),
    probeName: $('probeName').value.trim() || 'webrtc-browser',
    agentId: $('agentId').value.trim(),
    collectInterval: Math.max(1, Math.min(10, parseInt($('collectInterval').value) || 2)) * 1000,
    pushInterval: Math.max(3, Math.min(30, parseInt($('pushInterval').value) || 5)) * 1000,
    enabled: $('enabled').checked,
  };
  if (!newConfig.agentId) {
    newConfig.agentId = `browser-${Math.random().toString(36).substring(2, 8)}`;
  }
  chrome.storage.local.set({ probexConfig: newConfig });
}

// --- Auto-Test ---

async function onCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (window.__probexStartCapture) window.__probexStartCapture(); },
      world: 'MAIN',
    });
    // Close popup so user can click on the page
    window.close();
  } catch (e) {
    console.error('Capture failed:', e);
  }
}

function onAudioFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    chrome.storage.local.set({ autoTestAudio: reader.result });
    $('audioStatus').textContent = `${file.name} (${(file.size / 1024).toFixed(0)}KB)`;
  };
  reader.readAsDataURL(file);
}

let testRunning = false;

async function onToggleTest() {
  const selector = $('capturedSelector').value;
  if (!testRunning) {
    if (!selector) { alert('Please capture a button first'); return; }
    const interval = parseInt($('testInterval').value) || 30;
    testRunning = true;
    chrome.storage.local.set({
      autoTestConfig: { running: true, selector, interval },
    });
    $('startTestBtn').textContent = 'Stop';
    $('startTestBtn').className = 'btn-test running';
    $('testStatus').textContent = 'Running...';
  } else {
    testRunning = false;
    chrome.storage.local.set({
      autoTestConfig: { running: false, selector, interval: parseInt($('testInterval').value) || 30 },
    });
    $('startTestBtn').textContent = 'Start';
    $('startTestBtn').className = 'btn-test';
    $('testStatus').textContent = 'Stopped';
  }
}

function updateAutoTestUI(liveStats) {
  if (!liveStats?.autoTest) return;
  const at = liveStats.autoTest;
  if (at.running) {
    testRunning = true;
    $('startTestBtn').textContent = 'Stop';
    $('startTestBtn').className = 'btn-test running';
    $('testStatus').textContent = `Cycle #${at.cycles}`;
  }
  if (at.hasAudio) {
    $('audioStatus').textContent = `Audio loaded (${at.audioDuration.toFixed(1)}s)`;
  }
}

async function loadAutoTestConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('autoTestConfig', (stored) => {
      resolve(stored.autoTestConfig || {});
    });
  });
}

// --- Poll ---

async function poll() {
  const config = await loadConfig();
  const liveStats = await queryActiveTab();
  updateStatus(config, liveStats);
  updateAutoTestUI(liveStats);
}

// --- Init ---

async function init() {
  const config = await loadConfig();
  updateConfigForm(config);

  // Load auto-test config
  const atConfig = await loadAutoTestConfig();
  if (atConfig.selector) $('capturedSelector').value = atConfig.selector;
  if (atConfig.interval) $('testInterval').value = atConfig.interval;
  if (atConfig.running) {
    testRunning = true;
    $('startTestBtn').textContent = 'Stop';
    $('startTestBtn').className = 'btn-test running';
  }

  // Check if audio is loaded
  chrome.storage.local.get('autoTestAudio', (stored) => {
    if (stored.autoTestAudio) {
      $('audioStatus').textContent = 'Audio loaded';
    }
  });

  await poll();

  $('saveBtn').addEventListener('click', onSave);
  $('captureBtn').addEventListener('click', onCapture);
  $('audioFile').addEventListener('change', onAudioFile);
  $('startTestBtn').addEventListener('click', onToggleTest);

  setInterval(poll, 2000);
}

document.addEventListener('DOMContentLoaded', init);
