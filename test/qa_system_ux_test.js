/**
 * Bandit QA Comprehensive System & User Experience Test Suite
 * Conducts automated end-to-end system testing, edge cases, security robustness,
 * resilience, and user experience / accessibility validation.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const { safeCompare, generateMediaTicket, isValidMediaTicket, isValidToken } = require('../src/auth');
const WhisperAnalyzer = require('../src/whisperAnalyzer');
const AudioCapture = require('../src/audioCapture');
const RecordingManager = require('../src/recordingManager');

const PORT = 8086;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_TOKEN = 'bandit_qa_secret_token_2026';

let serverProc = null;
const testResults = [];

function recordTest(suite, testId, description, passed, details = '') {
  testResults.push({ suite, testId, description, passed, details });
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`  [${icon}] ${testId}: ${description}`);
  if (details && !passed) {
    console.log(`         Details: ${details}`);
  }
}

function httpGet(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${urlPath}`, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
      });
    }).on('error', reject);
  });
}

function httpPost(urlPath, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function httpDelete(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method: 'DELETE',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startTestServer() {
  return new Promise((resolve, reject) => {
    console.log(`[QA Suite] Launching Bandit server instance on port ${PORT}...`);
    serverProc = spawn('node', ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        AUTH_TOKEN: TEST_TOKEN,
        AUDIO_DEVICE: 'test',
        AUDIO_DRIVER: 'lavfi',
        CAPTURE_MODE: 'continuous',
        AUTO_RECORDING_ENABLED: 'true',
        RECORDING_SEGMENT_SECONDS: '3600',
        RECORDING_RETENTION_HOURS: '48'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutData = '';
    let ready = false;

    serverProc.stdout.on('data', (d) => {
      const msg = d.toString();
      stdoutData += msg;
      if (!ready && stdoutData.includes('BANDIT - Real-time Audio Surveillance Active')) {
        ready = true;
        setTimeout(resolve, 600); // Give socket extra moment
      }
    });

    serverProc.stderr.on('data', (d) => {});

    serverProc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server exited prematurely with code ${code}`));
    });

    setTimeout(() => {
      if (!ready) reject(new Error('Server start timed out after 8s'));
    }, 8000);
  });
}

function stopTestServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
  }
}

// =============================================================================
// TEST SUITES
// =============================================================================

async function runUnitAndSecurityTests() {
  console.log('\n=== [1] UNIT & SECURITY SYSTEM TESTS ===');

  // SEC-AUTH-01: Timing-safe token comparison
  try {
    const match = safeCompare(TEST_TOKEN, TEST_TOKEN);
    const mismatch = safeCompare(TEST_TOKEN, 'wrong_token');
    assert.strictEqual(match, true);
    assert.strictEqual(mismatch, false);
    recordTest('Security', 'SEC-AUTH-01', 'Timing-safe comparison correctly compares tokens', true);
  } catch (err) {
    recordTest('Security', 'SEC-AUTH-01', 'Timing-safe comparison failed', false, err.message);
  }

  // SEC-AUTH-02: Non-string input to isValidToken (robustness against type crashes)
  try {
    let crashNumber = false;
    let crashObject = false;
    try { isValidToken(12345, TEST_TOKEN); } catch { crashNumber = true; }
    try { isValidToken({}, TEST_TOKEN); } catch { crashObject = true; }
    
    // In current implementation, providedToken.trim throws TypeError!
    if (crashNumber || crashObject) {
      recordTest('Security', 'SEC-AUTH-02', 'Input type handling in isValidToken (detect non-string crash)', false, 
        'isValidToken throws TypeError on non-string inputs like 12345 or {} instead of returning false.');
    } else {
      recordTest('Security', 'SEC-AUTH-02', 'Input type handling in isValidToken handles non-string safely', true);
    }
  } catch (err) {
    recordTest('Security', 'SEC-AUTH-02', 'Input type handling in isValidToken failed unexpectedly', false, err.message);
  }

  // SEC-AUTH-04: Media ticket expiration
  try {
    process.env.AUTH_TOKEN = TEST_TOKEN;
    const shortTicket = generateMediaTicket('bandit_rec_sample.mp3', 1); // 1s validity
    assert.strictEqual(isValidMediaTicket(shortTicket, 'bandit_rec_sample.mp3'), true);
    
    // Wait 2s for expiry
    await new Promise(r => setTimeout(r, 2100));
    const expiredValid = isValidMediaTicket(shortTicket, 'bandit_rec_sample.mp3');
    assert.strictEqual(expiredValid, false, 'Expired ticket should evaluate to false');
    recordTest('Security', 'SEC-AUTH-04', 'Short-lived media tickets expire strictly after duration', true);
  } catch (err) {
    recordTest('Security', 'SEC-AUTH-04', 'Short-lived media ticket expiration test failed', false, err.message);
  }

  // SEC-AUTH-05: Media ticket filename scoping
  try {
    const scopedTicket = generateMediaTicket('bandit_rec_specific.mp3', 60);
    const matchSame = isValidMediaTicket(scopedTicket, 'bandit_rec_specific.mp3');
    const matchDifferent = isValidMediaTicket(scopedTicket, 'bandit_rec_other.mp3');
    assert.strictEqual(matchSame, true);
    assert.strictEqual(matchDifferent, false);
    recordTest('Security', 'SEC-AUTH-05', 'Media ticket enforces strict file binding', true);
  } catch (err) {
    recordTest('Security', 'SEC-AUTH-05', 'Media ticket filename scoping failed', false, err.message);
  }
}

async function runApiSystemTests() {
  console.log('\n=== [2] REST API & SYSTEM EDGE CASE TESTS ===');

  // SYS-API-01: Public status endpoint
  try {
    const res = await httpGet('/api/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.appName, 'Bandit Audio Surveillance');
    assert.strictEqual(res.body.authRequired, true);
    assert.strictEqual(res.body.isAuthenticated, false);
    recordTest('System API', 'SYS-API-01', 'GET /api/status returns telemetry and detects unauthenticated state', true);
  } catch (err) {
    recordTest('System API', 'SYS-API-01', 'GET /api/status failed', false, err.message);
  }

  // SYS-API-02: Auth verification with non-string payload
  try {
    const res = await httpPost('/api/auth/verify', { token: 12345 });
    if (res.status === 500) {
      recordTest('System API', 'SYS-API-02', 'POST /api/auth/verify with non-string payload crashes server (HTTP 500)', false,
        `Server responded with HTTP 500: ${JSON.stringify(res.body || res.raw)}`);
    } else {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.valid, false);
      recordTest('System API', 'SYS-API-02', 'POST /api/auth/verify handles non-string payload gracefully', true);
    }
  } catch (err) {
    recordTest('System API', 'SYS-API-02', 'POST /api/auth/verify non-string test error', false, err.message);
  }

  // SYS-API-03: Auth rate limiting on /api/auth/verify
  try {
    let throttled = false;
    for (let i = 0; i < 22; i++) {
      const res = await httpPost('/api/auth/verify', { token: `wrong_attempt_${i}` });
      if (res.status === 429) {
        throttled = true;
        break;
      }
    }
    assert.strictEqual(throttled, true, 'Should throttle with HTTP 429 after 20 attempts');
    recordTest('System API', 'SYS-API-03', 'Auth rate limiter triggers HTTP 429 upon reaching failed threshold', true);
  } catch (err) {
    recordTest('System API', 'SYS-API-03', 'Auth rate limiter test failed', false, err.message);
  }

  // SYS-API-04: HTTP Range Header malformed edge cases
  try {
    // Look up or wait for a sample recording file in vault
    const recsRes = await httpGet('/api/recordings', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    const recordings = recsRes.body?.recordings || [];
    if (recordings.length > 0) {
      const testFile = recordings[0].filename;

      // Probe 1: Malformed Range bytes=0-abc
      const resMalformed = await httpGet(`/api/recordings/${encodeURIComponent(testFile)}`, {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Range': 'bytes=0-abc'
      });

      const clHeader = resMalformed.headers['content-length'];
      if (clHeader === 'NaN' || isNaN(parseInt(clHeader, 10))) {
        recordTest('System API', 'SYS-API-04', 'Range header bytes=0-abc produces Content-Length: NaN violation', false,
          `Server emitted invalid Content-Length: "${clHeader}" violating HTTP spec.`);
      } else {
        assert.ok(resMalformed.status === 206 || resMalformed.status === 416 || resMalformed.status === 200);
        recordTest('System API', 'SYS-API-04', 'Range header bytes=0-abc handled safely', true);
      }

      // Probe 2: Out of bounds range
      const resOob = await httpGet(`/api/recordings/${encodeURIComponent(testFile)}`, {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Range': 'bytes=99999999-100000000'
      });
      assert.strictEqual(resOob.status, 416, 'Out of bounds range must return 416');
      recordTest('System API', 'SYS-API-04b', 'Range header out-of-bounds correctly returns HTTP 416', true);

    } else {
      recordTest('System API', 'SYS-API-04', 'Range header test skipped (no recordings found yet)', true);
    }
  } catch (err) {
    recordTest('System API', 'SYS-API-04', 'Range header edge case failed', false, err.message);
  }

  // SYS-API-05: Path traversal protection on transcript exports
  try {
    const resTrav = await httpGet('/api/analysis/jobs/..%2f..%2fpackage/export/txt', {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    assert.strictEqual(resTrav.status, 404, 'Traversal attempt must be rejected (404/400)');
    recordTest('System API', 'SYS-API-05', 'Transcript export endpoint rejects path traversal sequences', true);
  } catch (err) {
    recordTest('System API', 'SYS-API-05', 'Path traversal probe failed', false, err.message);
  }

  // SYS-API-06: DSP Preset parameter validation
  try {
    const resInvalidPreset = await httpPost('/api/dsp/preset', { preset: 'non_existent_preset' }, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    assert.strictEqual(resInvalidPreset.status, 400);
    recordTest('System API', 'SYS-API-06', 'POST /api/dsp/preset rejects invalid presets with HTTP 400', true);
  } catch (err) {
    recordTest('System API', 'SYS-API-06', 'DSP preset validation test failed', false, err.message);
  }

  // SYS-API-07: Audio Capture Device parameter validation
  try {
    const resInvalidDev = await httpPost('/api/capture/device', { device: 'invalid_audio_device_xyz' }, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    assert.strictEqual(resInvalidDev.status, 400);
    recordTest('System API', 'SYS-API-07', 'POST /api/capture/device rejects unknown devices with HTTP 400', true);
  } catch (err) {
    recordTest('System API', 'SYS-API-07', 'Audio capture device validation test failed', false, err.message);
  }
}

async function runRecordingVaultAndWhisperTests() {
  console.log('\n=== [3] RECORDING VAULT & WHISPER ANALYSIS TESTS ===');

  // SYS-VAULT-01: Auto-recording toggle
  try {
    const resToggle = await httpPost('/api/recordings/toggle', { enabled: false }, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    assert.strictEqual(resToggle.status, 200);
    assert.strictEqual(resToggle.body.enabled, false);

    // Toggle back on
    const resToggleBack = await httpPost('/api/recordings/toggle', { enabled: true }, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    assert.strictEqual(resToggleBack.status, 200);
    assert.strictEqual(resToggleBack.body.enabled, true);
    recordTest('Recording Vault', 'SYS-VAULT-01', 'POST /api/recordings/toggle successfully toggles recording state', true);
  } catch (err) {
    recordTest('Recording Vault', 'SYS-VAULT-01', 'Auto-recording toggle failed', false, err.message);
  }

  // SYS-VAULT-02: Prevent deleting active recording segment
  try {
    const listRes = await httpGet('/api/recordings', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    const currentSegment = listRes.body?.stats?.currentSegment?.filename;
    if (currentSegment) {
      const delRes = await httpDelete(`/api/recordings/${encodeURIComponent(currentSegment)}`, {
        'Authorization': `Bearer ${TEST_TOKEN}`
      });
      assert.strictEqual(delRes.status, 400);
      assert.ok(delRes.body.error.includes('active') || delRes.body.error.includes('recording'));
      recordTest('Recording Vault', 'SYS-VAULT-02', 'DELETE /api/recordings blocks deletion of actively recording segment', true);
    } else {
      recordTest('Recording Vault', 'SYS-VAULT-02', 'Delete active segment test skipped (no active segment reported)', true);
    }
  } catch (err) {
    recordTest('Recording Vault', 'SYS-VAULT-02', 'Active segment delete protection failed', false, err.message);
  }

  // SYS-WHISPER-01: Subtitle Exporter null-safety validation
  try {
    const analyzer = new WhisperAnalyzer({ recordingsDir: path.join(__dirname, '..', 'recordings') });
    const malformedReport = {
      id: 'test_report_null_text',
      filename: 'bandit_rec_test.mp3',
      segments: [
        { id: 0, start: 0.0, end: 1.5, speaker: 'Speaker 1', text: null },
        { id: 1, start: 1.6, end: 2.8, speaker: null, text: 'Valid speech fragment' }
      ]
    };

    let crashedSrt = false;
    let crashedVtt = false;
    let crashedTxt = false;

    try { analyzer.exportToSrt(malformedReport); } catch (e) { crashedSrt = true; }
    try { analyzer.exportToVtt(malformedReport); } catch (e) { crashedVtt = true; }
    try { analyzer.exportToTxt(malformedReport); } catch (e) { crashedTxt = true; }

    if (crashedSrt || crashedVtt || crashedTxt) {
      recordTest('Whisper Analysis', 'SYS-WHISPER-01', 'Subtitle exporters null safety for missing text in segments', false,
        'exportToSrt/exportToVtt/exportToTxt throw TypeError when seg.text is null or undefined.');
    } else {
      recordTest('Whisper Analysis', 'SYS-WHISPER-01', 'Subtitle exporters handle null/missing segment text gracefully', true);
    }
  } catch (err) {
    recordTest('Whisper Analysis', 'SYS-WHISPER-01', 'Subtitle exporter null safety test error', false, err.message);
  }

  // SYS-WHISPER-02: Live snapshot analysis endpoint
  try {
    const resSnapshot = await httpPost('/api/analysis/live-snapshot', { seconds: 5 }, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    assert.strictEqual(resSnapshot.status, 200);
    assert.ok(resSnapshot.body.report);
    assert.ok(resSnapshot.body.report.id);
    recordTest('Whisper Analysis', 'SYS-WHISPER-02', 'POST /api/analysis/live-snapshot captures and transcribes buffer', true);
  } catch (err) {
    recordTest('Whisper Analysis', 'SYS-WHISPER-02', 'Live snapshot analysis failed', false, err.message);
  }
}

async function runWebSocketTests() {
  console.log('\n=== [4] WEBSOCKET STREAMING & INTERACTION TESTS ===');

  // SYS-WS-01: WebSocket handshake and initialization payload
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream?token=${TEST_TOKEN}`, ['bandit-v1']);
    const initReceived = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket init timeout')), 4000);
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'init') {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {}
        }
      });
      ws.on('error', reject);
    });

    assert.strictEqual(initReceived.format, 'pcm_s16le');
    assert.strictEqual(initReceived.sampleRate, 24000);
    assert.ok(Array.isArray(initReceived.devices));
    assert.ok(initReceived.dspPresets);
    ws.close();
    recordTest('WebSocket', 'SYS-WS-01', 'WebSocket client authenticates and receives complete "init" handshake', true);
  } catch (err) {
    recordTest('WebSocket', 'SYS-WS-01', 'WebSocket handshake failed', false, err.message);
  }

  // SYS-WS-02: Ping-Pong roundtrip latency measurement
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream?token=${TEST_TOKEN}`, ['bandit-v1']);
    await new Promise((resolve) => ws.on('open', resolve));

    const pingTime = Date.now();
    ws.send(JSON.stringify({ type: 'ping', clientTime: pingTime }));

    const pongReceived = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pong response timeout')), 3000);
      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'pong') {
              clearTimeout(timer);
              resolve(msg);
            }
          } catch {}
        }
      });
    });

    assert.strictEqual(pongReceived.clientTime, pingTime);
    assert.ok(pongReceived.serverTime >= pingTime);
    ws.close();
    recordTest('WebSocket', 'SYS-WS-02', 'WebSocket ping/pong calculates round-trip telemetry accurately', true);
  } catch (err) {
    recordTest('WebSocket', 'SYS-WS-02', 'WebSocket ping/pong test failed', false, err.message);
  }

  // SYS-WS-03: Binary audio chunk streaming
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream?token=${TEST_TOKEN}`, ['bandit-v1']);
    let binaryChunkReceived = false;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        if (binaryChunkReceived) resolve();
        else reject(new Error('Did not receive binary audio chunk within 4s'));
      }, 4000);

      ws.on('message', (data, isBinary) => {
        if (isBinary && Buffer.isBuffer(data) && data.length > 0) {
          binaryChunkReceived = true;
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });

    recordTest('WebSocket', 'SYS-WS-03', 'WebSocket streams live binary PCM audio frames (Buffer format)', true);
  } catch (err) {
    recordTest('WebSocket', 'SYS-WS-03', 'WebSocket binary audio stream test failed', false, err.message);
  }

  // SYS-WS-04: Unauthenticated connection challenge & timeout
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream`, ['bandit-v1']);
    let authRequiredReceived = false;
    let closedCode = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), 6000); // Wait for 5s server auth timeout

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'auth_required') authRequiredReceived = true;
          } catch {}
        }
      });

      ws.on('close', (code) => {
        closedCode = code;
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', () => {});
    });

    assert.strictEqual(authRequiredReceived, true, 'Server must emit auth_required challenge');
    assert.strictEqual(closedCode, 4401, 'Unauthenticated socket must be terminated with 4401');
    recordTest('WebSocket', 'SYS-WS-04', 'Unauthenticated WebSocket receives auth challenge and times out with code 4401', true);
  } catch (err) {
    recordTest('WebSocket', 'SYS-WS-04', 'WebSocket unauthenticated challenge test failed', false, err.message);
  }
}

async function runUxAndA11yTests() {
  console.log('\n=== [5] USER EXPERIENCE (UX) & ACCESSIBILITY (A11Y) TESTS ===');

  const appJsPath = path.join(__dirname, '..', 'public', 'app.js');
  const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const styleCssPath = path.join(__dirname, '..', 'public', 'style.css');

  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const styleCss = fs.readFileSync(styleCssPath, 'utf8');

  // UX-A11Y-01: Duplicate escapeHtml function declarations in app.js
  try {
    const matches = appJs.match(/function\s+escapeHtml\s*\(/g) || [];
    if (matches.length > 1) {
      recordTest('UX & Code Quality', 'UX-A11Y-01', 'Duplicate escapeHtml declaration in public/app.js', false,
        `Found ${matches.length} declarations of escapeHtml in the same scope. The second declaration overrides the first without single-quote escaping or String conversion.`);
    } else {
      recordTest('UX & Code Quality', 'UX-A11Y-01', 'Single robust escapeHtml function declaration present', true);
    }
  } catch (err) {
    recordTest('UX & Code Quality', 'UX-A11Y-01', 'escapeHtml check error', false, err.message);
  }

  // UX-A11Y-02: Accessible labels on form controls
  try {
    const searchHasLabel = indexHtml.includes('for="transcriptSearchInput"') || indexHtml.includes('id="transcriptSearchInput" class="form-input form-input-sm" aria-label=');
    const vaultSelectHasLabel = indexHtml.includes('for="analysisVaultSelect"') || indexHtml.includes('id="analysisVaultSelect" class="form-select" aria-label=');
    const canvasHasA11y = indexHtml.includes('id="visualizerCanvas"') && (indexHtml.includes('aria-label=') || indexHtml.includes('role="img"'));

    const missing = [];
    if (!searchHasLabel) missing.push('#transcriptSearchInput lacks label or aria-label');
    if (!vaultSelectHasLabel) missing.push('#analysisVaultSelect lacks label or aria-label');
    if (!canvasHasA11y) missing.push('#visualizerCanvas lacks role="img" or aria-label');

    if (missing.length > 0) {
      recordTest('Accessibility (A11y)', 'UX-A11Y-02', 'Form inputs and canvas accessibility labels (WCAG 1.3.1 / 4.1.2)', false,
        missing.join('; '));
    } else {
      recordTest('Accessibility (A11y)', 'UX-A11Y-02', 'All interactive form elements have accessible labels', true);
    }
  } catch (err) {
    recordTest('Accessibility (A11y)', 'UX-A11Y-02', 'Accessible labels check error', false, err.message);
  }

  // UX-A11Y-03: Table action buttons screen-reader context
  try {
    // In renderRecordings in app.js, check if action buttons have aria-label with filename
    const hasContextualAriaLabels = appJs.includes('aria-label="Play ${escapeHtml(rec.filename)}') ||
      appJs.includes('aria-label="Play recording') ||
      appJs.includes('aria-label=`Play');

    if (!hasContextualAriaLabels) {
      recordTest('Accessibility (A11y)', 'UX-A11Y-03', 'Recording table action buttons have contextual aria-labels (WCAG 2.4.4)', false,
        'Buttons use generic text ("▶ Play", "🧠 Analyze", "⬇ Save", "🗑 Del") without file-specific aria-label context.');
    } else {
      recordTest('Accessibility (A11y)', 'UX-A11Y-03', 'Recording table action buttons include file-specific aria-labels', true);
    }
  } catch (err) {
    recordTest('Accessibility (A11y)', 'UX-A11Y-03', 'Table button a11y check error', false, err.message);
  }

  // UX-SEC-01: Token leakage in downloadExport URL query parameters
  try {
    const exportsUseQueryToken = appJs.includes('jobs/${encodeURIComponent(currentAnalysisReport.id)}/export/${format}?token=');
    if (exportsUseQueryToken) {
      recordTest('UX & Security', 'UX-SEC-01', 'Analysis subtitle exports leak master token in URL query parameter', false,
        'downloadExport() generates anchor links with ?token=... instead of using Authorization headers or signed media tickets.');
    } else {
      recordTest('UX & Security', 'UX-SEC-01', 'Analysis exports do not expose token in URL query string', true);
    }
  } catch (err) {
    recordTest('UX & Security', 'UX-SEC-01', 'Export token leak check error', false, err.message);
  }

  // UX-DESK-01: Responsive CSS and mobile viewport checks
  try {
    const hasMobileHeader = styleCss.includes('@media (max-width: 768px)') && styleCss.includes('.app-header');
    const hasFocusTrap = appJs.includes('trapFocus');
    const hasEscapeKeyDismissal = appJs.includes("e.key === 'Escape'");

    assert.strictEqual(hasMobileHeader, true);
    assert.strictEqual(hasFocusTrap, true);
    assert.strictEqual(hasEscapeKeyDismissal, true);
    recordTest('UX Interaction', 'UX-DESK-01', 'Modal focus traps, Escape dismissal, and responsive headers verified', true);
  } catch (err) {
    recordTest('UX Interaction', 'UX-DESK-01', 'UX interaction check failed', false, err.message);
  }
}

async function run() {
  console.log('======================================================');
  console.log('  STARTING BANDIT QA SYSTEM & UX TEST SUITE');
  console.log('======================================================');

  try {
    await runUnitAndSecurityTests();
    await startTestServer();
    await runApiSystemTests();
    await runRecordingVaultAndWhisperTests();
    await runWebSocketTests();
    await runUxAndA11yTests();
  } catch (err) {
    console.error('[QA Suite Fatality]:', err);
  } finally {
    stopTestServer();
  }

  console.log('\n======================================================');
  console.log('  TEST SUMMARY');
  console.log('======================================================');
  const total = testResults.length;
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;

  console.log(`Total Executed: ${total}`);
  console.log(`Passed:         ${passed}`);
  console.log(`Failed / Bugs:  ${failed}`);

  if (failed > 0) {
    console.log('\nIdentified Defects to Report to Software Engineering:');
    testResults.filter(r => !r.passed).forEach((r, idx) => {
      console.log(`[Defect ${idx + 1}] (${r.testId}) ${r.description}`);
      if (r.details) console.log(`   -> ${r.details}`);
    });
  }

  console.log('======================================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

run();
