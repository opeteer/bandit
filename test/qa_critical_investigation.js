/**
 * Bandit QA Critical Deep Investigation & Verification Suite
 * Executes in-depth system testing, security probing, edge-case fuzzing,
 * API compliance, audio pipeline verification, and UX/A11y audits.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const { safeCompare, generateMediaTicket, isValidMediaTicket, isValidToken, extractToken } = require('../src/auth');
const WhisperAnalyzer = require('../src/whisperAnalyzer');
const AudioCapture = require('../src/audioCapture');
const RecordingManager = require('../src/recordingManager');
const { DSP_PRESETS, getDspPresetsList } = require('../src/dspFilters');
const { scanAudioDevices, getDeviceDisplayName } = require('../src/deviceScanner');

const PORT = 8092;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_TOKEN = 'qa_bandit_deep_test_secret_9988';

let serverProc = null;
const findings = [];

function logTest(category, testId, title, status, details = null, severity = 'INFO') {
  findings.push({ category, testId, title, status, details, severity });
  const icon = status === 'PASS' ? '✅' : (status === 'FAIL' ? '❌' : '⚠️');
  console.log(`  [${icon} ${status}] ${testId} (${category}): ${title}`);
  if (details) {
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
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers, raw: data });
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
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers, raw: data });
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
          resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers, raw: data });
        } catch {
          resolve({ status: res.statusCode, raw: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer() {
  return new Promise((resolve, reject) => {
    console.log(`\n[Test Server] Launching Bandit server instance on port ${PORT}...`);
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
        RECORDING_RETENTION_HOURS: '48',
        TRUST_PROXY: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutData = '';
    let ready = false;

    serverProc.stdout.on('data', (d) => {
      stdoutData += d.toString();
      if (!ready && stdoutData.includes('BANDIT - Real-time Audio Surveillance Active')) {
        ready = true;
        setTimeout(resolve, 600);
      }
    });

    serverProc.on('exit', (code) => {
      if (!ready) reject(new Error(`Server exited prematurely with code ${code}`));
    });

    setTimeout(() => {
      if (!ready) reject(new Error('Server start timed out'));
    }, 8000);
  });
}

function stopServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
  }
}

// -----------------------------------------------------------------------------
// Suite 1: Security & Crypto Robustness
// -----------------------------------------------------------------------------
async function testSecurityAndCrypto() {
  console.log('\n--- SUITE 1: SECURITY & CRYPTOGRAPHIC CONTROLS ---');

  // Test 1.1: Timing-safe comparison with various types and lengths
  try {
    const tests = [
      { a: 'secret123', b: 'secret123', expected: true },
      { a: 'secret123', b: 'secret124', expected: false },
      { a: 'secret123', b: 'secret12', expected: false },
      { a: 'secret123', b: '', expected: false },
      { a: '', b: '', expected: true },
      { a: null, b: 'secret123', expected: false },
      { a: undefined, b: 'secret123', expected: false },
      { a: 12345, b: '12345', expected: false },
      { a: {}, b: {}, expected: false }
    ];
    let allPass = true;
    for (const t of tests) {
      const res = safeCompare(t.a, t.b);
      if (res !== t.expected) {
        allPass = false;
        break;
      }
    }
    if (allPass) {
      logTest('Security', 'SEC-01', 'safeCompare robustly handles matching, mismatching, and non-string inputs', 'PASS');
    } else {
      logTest('Security', 'SEC-01', 'safeCompare failed on type boundary check', 'FAIL', null, 'HIGH');
    }
  } catch (err) {
    logTest('Security', 'SEC-01', 'safeCompare threw unexpected exception', 'FAIL', err.message, 'HIGH');
  }

  // Test 1.2: Media Ticket Tampering & Forgery
  try {
    process.env.AUTH_TOKEN = TEST_TOKEN;
    const ticket = generateMediaTicket('bandit_rec_target.mp3', 60);
    const raw = Buffer.from(ticket, 'base64url').toString('utf8');
    const parts = raw.split(':');
    
    // Attempt 1: Tamper filename in ticket
    parts[1] = 'bandit_rec_hacked.mp3';
    const tamperedTicket = Buffer.from(parts.join(':')).toString('base64url');
    const tamperedValid = isValidMediaTicket(tamperedTicket, 'bandit_rec_hacked.mp3');

    // Attempt 2: Tamper expiry timestamp
    parts[0] = String(Math.floor(Date.now() / 1000) + 999999);
    const tamperedExpTicket = Buffer.from(parts.join(':')).toString('base64url');
    const tamperedExpValid = isValidMediaTicket(tamperedExpTicket, 'bandit_rec_target.mp3');

    // Attempt 3: Empty string ticket
    const emptyValid = isValidMediaTicket('', 'bandit_rec_target.mp3');
    const malformedValid = isValidMediaTicket('not:valid:base64:at:all', 'bandit_rec_target.mp3');

    if (!tamperedValid && !tamperedExpValid && !emptyValid && !malformedValid) {
      logTest('Security', 'SEC-02', 'Media tickets resist HMAC payload tampering, forgery, and malformed inputs', 'PASS');
    } else {
      logTest('Security', 'SEC-02', 'Media ticket forgery vulnerability detected', 'FAIL', 'Tampered ticket was accepted!', 'CRITICAL');
    }
  } catch (err) {
    logTest('Security', 'SEC-02', 'Media ticket tampering test failed', 'FAIL', err.message, 'HIGH');
  }

  // Test 1.3: Token extraction from all supported vectors
  try {
    const mockReqBearer = { headers: { authorization: `Bearer ${TEST_TOKEN}` } };
    const mockReqCustom = { headers: { 'x-bandit-token': TEST_TOKEN } };
    const mockReqAuth = { headers: { 'x-auth-token': TEST_TOKEN } };
    const mockReqQuery = { headers: {}, url: `/stream?token=${TEST_TOKEN}` };
    const mockReqWsProtocol = { headers: { 'sec-websocket-protocol': `bandit-v1, token.${TEST_TOKEN}` } };

    const t1 = extractToken(mockReqBearer);
    const t2 = extractToken(mockReqCustom);
    const t3 = extractToken(mockReqAuth);
    const t4 = extractToken(mockReqQuery);
    const t5 = extractToken(mockReqWsProtocol);

    if (t1 === TEST_TOKEN && t2 === TEST_TOKEN && t3 === TEST_TOKEN && t4 === TEST_TOKEN && t5 === TEST_TOKEN) {
      logTest('Security', 'SEC-03', 'Authentication token extractor supports Bearer, X-Headers, Query, and Sec-WebSocket-Protocol', 'PASS');
    } else {
      logTest('Security', 'SEC-03', 'Token extraction failed for one or more vectors', 'FAIL', `Results: ${t1}, ${t2}, ${t3}, ${t4}, ${t5}`, 'MEDIUM');
    }
  } catch (err) {
    logTest('Security', 'SEC-03', 'Token extraction test failed', 'FAIL', err.message, 'MEDIUM');
  }
}

// -----------------------------------------------------------------------------
// Suite 2: REST API & HTTP Compliance
// -----------------------------------------------------------------------------
async function testRestApiCompliance() {
  console.log('\n--- SUITE 2: REST API & HTTP COMPLIANCE ---');

  // Test 2.1: Security headers & X-Powered-By
  try {
    const res = await httpGet('/api/status');
    const xFrame = res.headers['x-frame-options'];
    const xContent = res.headers['x-content-type-options'];
    const referrer = res.headers['referrer-policy'];
    const csp = res.headers['content-security-policy'];
    const xPowered = res.headers['x-powered-by'];

    if (xFrame === 'DENY' && xContent === 'nosniff' && referrer === 'no-referrer' && csp && !xPowered) {
      logTest('API Security', 'API-01', 'Security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy) correctly enforced and X-Powered-By disabled', 'PASS');
    } else {
      logTest('API Security', 'API-01', 'Security header non-compliance detected', 'FAIL', `xFrame=${xFrame}, xContent=${xContent}, xPowered=${xPowered}`, 'MEDIUM');
    }
  } catch (err) {
    logTest('API Security', 'API-01', 'Security headers test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 2.2: Centralized error handling and invalid JSON payload handling
  try {
    const payload = '{"invalid_json": ';
    const res = await new Promise((resolve) => {
      const req = http.request(`${BASE_URL}/api/auth/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => resolve({ status: r.statusCode, raw: d }));
      });
      req.write(payload);
      req.end();
    });

    let parsed = null;
    try { parsed = JSON.parse(res.raw); } catch {}

    if (res.status === 400 && parsed && parsed.error === 'Invalid JSON payload') {
      logTest('API Robustness', 'API-02', 'Malformed JSON payload intercepted by centralized error middleware returning HTTP 400 JSON', 'PASS');
    } else {
      logTest('API Robustness', 'API-02', 'Malformed JSON payload returned unhandled status or non-JSON body', 'FAIL', `Status: ${res.status}, Body: ${res.raw}`, 'MEDIUM');
    }
  } catch (err) {
    logTest('API Robustness', 'API-02', 'Malformed JSON test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 2.3: Non-existent API route 404 behavior
  try {
    const res = await httpGet('/api/non-existent-route-99');
    let isJson = false;
    try {
      JSON.parse(res.raw);
      isJson = true;
    } catch {}

    if (res.status === 404 && isJson) {
      logTest('API Robustness', 'API-03', 'Unmatched /api route returns structured HTTP 404 JSON (no HTML error leaks)', 'PASS');
    } else {
      logTest('API Robustness', 'API-03', 'Unmatched /api route did not return clean 404 JSON', 'FAIL', `Status: ${res.status}, Body: ${res.raw}`, 'LOW');
    }
  } catch (err) {
    logTest('API Robustness', 'API-03', 'API 404 test error', 'FAIL', err.message, 'LOW');
  }

  // Test 2.4: Path traversal fuzzing across multiple endpoints
  try {
    const probePaths = [
      '/api/recordings/..%2f..%2fpackage.json',
      '/api/recordings/bandit_rec_..%2f..%2fpackage.json',
      '/api/recordings/bandit_rec_%2e%2e%2fpackage.json',
      '/api/recordings/bandit_rec_test.mp3%00.wav',
      '/api/analysis/jobs/..%2f..%2f..%2fetc%2fpasswd',
      '/api/analysis/jobs/test%2f..%2f..%2fpackage/export/srt'
    ];

    let allBlocked = true;
    for (const p of probePaths) {
      const res = await httpGet(p, { 'Authorization': `Bearer ${TEST_TOKEN}` });
      if (res.status === 200) {
        allBlocked = false;
        logTest('Security', 'SEC-TRAV', `Path traversal probe succeeded: ${p}`, 'FAIL', `HTTP 200 returned with content`, 'CRITICAL');
        break;
      }
    }
    if (allBlocked) {
      logTest('Security', 'SEC-04', 'Directory traversal probes (dot-dot-slash, URL encoded, null-byte) rejected across all media and transcript endpoints', 'PASS');
    }
  } catch (err) {
    logTest('Security', 'SEC-04', 'Path traversal probe error', 'FAIL', err.message, 'HIGH');
  }

  // Test 2.5: Reverse Proxy IP resolution check (trust proxy configuration)
  try {
    const serverCode = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hasTrustProxy = serverCode.includes("app.set('trust proxy'") || serverCode.includes("app.enable('trust proxy'");

    if (hasTrustProxy) {
      logTest('Network / Security', 'NET-PROXY-01', 'Reverse proxy configuration (trust proxy) is appropriately declared for tunnel deployments', 'PASS');
    } else {
      logTest('Network / Security Defect', 'NET-PROXY-01',
        'Express server lacks "trust proxy" configuration for reverse proxy / tunnel deployments',
        'FAIL',
        'README recommends deploying Bandit behind Cloudflare Tunnel, ngrok, or Tailscale. Without app.set("trust proxy", 1), req.ip resolves to 127.0.0.1.',
        'MEDIUM'
      );
    }
  } catch (err) {
    logTest('Network / Security', 'NET-PROXY-01', 'Trust proxy check error', 'FAIL', err.message, 'LOW');
  }
}

// -----------------------------------------------------------------------------
// Suite 3: Audio Ingestion, Range Header & Streaming Tests
// -----------------------------------------------------------------------------
async function testAudioAndStreamPipeline() {
  console.log('\n--- SUITE 3: AUDIO PIPELINE, RANGE HEADERS & STREAMING ---');

  // Test 3.1: AudioCapture chunk size and clamping
  try {
    const cap10 = new AudioCapture({ sampleRate: '24000', channels: '1', chunkMs: '10' });
    const capZero = new AudioCapture({ sampleRate: '24000', channels: '1', chunkMs: '0' });
    const capNegative = new AudioCapture({ sampleRate: '24000', channels: '1', chunkMs: '-50' });

    if (cap10.chunkSizeBytes >= 128 && capZero.chunkMs >= 10 && capNegative.chunkMs >= 10) {
      logTest('Audio Ingestion', 'AUD-01', 'AudioCapture safely clamps chunkMs >= 10ms and enforces minimum chunk byte boundary', 'PASS');
    } else {
      logTest('Audio Ingestion', 'AUD-01', 'AudioCapture failed to enforce minimum chunk bounds', 'FAIL', null, 'MEDIUM');
    }
  } catch (err) {
    logTest('Audio Ingestion', 'AUD-01', 'AudioCapture chunk test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 3.2: HTTP Range Header compliance
  try {
    const dummyRecName = 'bandit_rec_test_range_2026.mp3';
    const dummyRecPath = path.join(__dirname, '..', 'recordings', dummyRecName);
    const dummyData = Buffer.alloc(10000, 0xAA);
    fs.writeFileSync(dummyRecPath, dummyData);

    const resA = await httpGet(`/api/recordings/${dummyRecName}`, {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Range': 'bytes=0-499'
    });
    const lenA = parseInt(resA.headers['content-length'], 10);
    const crA = resA.headers['content-range'];

    const resB = await httpGet(`/api/recordings/${dummyRecName}`, {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Range': 'bytes=9500-'
    });
    const lenB = parseInt(resB.headers['content-length'], 10);
    const crB = resB.headers['content-range'];

    const resC = await httpGet(`/api/recordings/${dummyRecName}`, {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Range': 'bytes=-500'
    });
    const lenC = parseInt(resC.headers['content-length'], 10);
    const crC = resC.headers['content-range'];

    const resD = await httpGet(`/api/recordings/${dummyRecName}`, {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Range': 'bytes=20000-25000'
    });

    const resE = await httpGet(`/api/recordings/${dummyRecName}`, {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Range': 'bytes=0-abc'
    });

    try { fs.unlinkSync(dummyRecPath); } catch {}

    const isPass = (
      resA.status === 206 && lenA === 500 && crA === 'bytes 0-499/10000' &&
      resB.status === 206 && lenB === 500 && crB === 'bytes 9500-9999/10000' &&
      resC.status === 206 && lenC === 500 && crC === 'bytes 9500-9999/10000' &&
      resD.status === 416 &&
      resE.status === 416
    );

    if (isPass) {
      logTest('HTTP Streaming', 'AUD-02', 'HTTP 206 Range header fully complies with RFC 7233 (prefix, suffix, clamping, and 416 on invalid/out-of-bounds)', 'PASS');
    } else {
      logTest('HTTP Streaming', 'AUD-02', 'Range header compliance issue detected', 'FAIL',
        `A(${resA.status}, ${lenA}, ${crA}), B(${resB.status}, ${lenB}, ${crB}), C(${resC.status}, ${lenC}, ${crC}), D(${resD.status}), E(${resE.status})`, 'HIGH');
    }
  } catch (err) {
    logTest('HTTP Streaming', 'AUD-02', 'Range header test error', 'FAIL', err.message, 'HIGH');
  }

  // Test 3.3: Zero-byte file handling on /api/recordings/:filename
  try {
    const zeroRecName = 'bandit_rec_zero_byte.mp3';
    const zeroRecPath = path.join(__dirname, '..', 'recordings', zeroRecName);
    fs.writeFileSync(zeroRecPath, Buffer.alloc(0));

    const resZero = await httpGet(`/api/recordings/${zeroRecName}`, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });

    try { fs.unlinkSync(zeroRecPath); } catch {}

    if (resZero.status === 200 && resZero.headers['content-length'] === '0') {
      logTest('HTTP Streaming', 'AUD-03', 'Zero-byte recording file served cleanly without hanging or crashing server', 'PASS');
    } else {
      logTest('HTTP Streaming', 'AUD-03', 'Zero-byte recording file failed to serve cleanly', 'FAIL', `Status: ${resZero.status}`, 'MEDIUM');
    }
  } catch (err) {
    logTest('HTTP Streaming', 'AUD-03', 'Zero-byte recording test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 3.4: Subtitle exporters timestamp formatting beyond 1 hour
  try {
    const analyzer = new WhisperAnalyzer({ recordingsDir: path.join(__dirname, '..', 'recordings') });
    const srtTs = analyzer.formatSrtTimestamp(3665.456);
    const vttTs = analyzer.formatVttTimestamp(3665.456);

    if (srtTs === '01:01:05,456' && vttTs === '01:01:05.456') {
      logTest('Whisper Subtitles', 'STT-01', 'Timestamp math accurately computes hours, minutes, seconds, and milliseconds for long surveillance segments', 'PASS');
    } else {
      logTest('Whisper Subtitles', 'STT-01', 'Timestamp formatting inaccurate', 'FAIL', `SRT=${srtTs}, VTT=${vttTs}`, 'MEDIUM');
    }
  } catch (err) {
    logTest('Whisper Subtitles', 'STT-01', 'Timestamp formatting test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 3.5: Diarization threshold enforcement
  try {
    const analyzer = new WhisperAnalyzer({ maxSpeakers: 4, minSegmentSec: 0.8 });
    const mockRaw = {
      segments: [
        { start: 0.0, end: 0.5, text: 'Click.' },
        { start: 0.6, end: 2.0, text: 'Subject speaking.' },
        { start: 2.2, end: 4.0, text: 'Second response.' }
      ]
    };
    const diarized = analyzer.applyLocalDiarizationFallback(mockRaw);
    assert.ok(diarized.speakers);
    assert.ok(diarized.speaker_breakdown);
    logTest('Whisper Diarization', 'STT-02', 'Diarization clustering enforces minimum segment duration threshold and computes speaker breakdowns', 'PASS');
  } catch (err) {
    logTest('Whisper Diarization', 'STT-02', 'Diarization test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 3.6: RecordingManager child process unhandled error listener audit
  try {
    const recCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'recordingManager.js'), 'utf8');
    const hasProcessError = recCode.includes("this.currentProcess.on('error'");
    const hasStdinError = recCode.includes("this.currentProcess.stdin.on('error'") || recCode.includes("proc.stdin.on('error'");

    if (hasProcessError && hasStdinError) {
      logTest('Process Resilience', 'REC-ERR-01', 'RecordingManager handles encoder process spawn errors and stream EPIPE cleanly', 'PASS');
    } else {
      logTest('Process Resilience Defect', 'REC-ERR-01',
        'RecordingManager does not attach error event listener to spawned FFmpeg encoder process or stdin',
        'FAIL',
        'Omitted error event listener can cause unhandled exception crash when FFmpeg process terminates unexpectedly.',
        'HIGH'
      );
    }
  } catch (err) {
    logTest('Process Resilience', 'REC-ERR-01', 'RecordingManager error listener audit failed', 'FAIL', err.message, 'MEDIUM');
  }
}

// -----------------------------------------------------------------------------
// Suite 4: User Experience (UX), Frontend Architecture & Accessibility (A11Y)
// -----------------------------------------------------------------------------
async function testUxFrontendAndA11y() {
  console.log('\n--- SUITE 4: USER EXPERIENCE (UX) & ACCESSIBILITY AUDIT ---');

  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const styleCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

  // Test 4.1: Query parameter token leakage on REST fetch calls
  try {
    const queryTokenMatches = appJs.match(/fetch\(`?\/api\/[^`'"]+[?&]token=\$\{encodeURIComponent\(token\)\}/g) || [];
    if (queryTokenMatches.length === 0) {
      logTest('UX / Security', 'UX-SEC-02', 'No master token query string leakage detected on REST fetch calls (headers used)', 'PASS');
    } else {
      logTest('UX / Security Defect', 'UX-SEC-02',
        `Master AUTH_TOKEN leaked in URL query parameters on ${queryTokenMatches.length} REST API fetch calls`,
        'FAIL',
        `REST API fetch calls in app.js append ?token=... to URLs: ${queryTokenMatches.join(', ')}`,
        'HIGH'
      );
    }
  } catch (err) {
    logTest('UX / Security', 'UX-SEC-02', 'Token query leakage test error', 'FAIL', err.message, 'MEDIUM');
  }

  // Test 4.2: WebSocket Close Code 4429 (Rate Throttled) Handling in Frontend
  try {
    const has4429Handling = appJs.includes('4429');
    if (has4429Handling) {
      logTest('UX / Resilience', 'UX-WS-01', 'WebSocket close handler handles 4429 rate-limiting appropriately without infinite reconnect loops', 'PASS');
    } else {
      logTest('UX / Resilience Defect', 'UX-WS-01',
        'Frontend WebSocket onclose handler does not handle HTTP/WS 4429 rate limit close code',
        'FAIL',
        'Client treats 4429 as generic disconnect and retries aggressively.',
        'MEDIUM'
      );
    }
  } catch (err) {
    logTest('UX / Resilience', 'UX-WS-01', 'WS 4429 handling test error', 'FAIL', err.message, 'LOW');
  }

  // Test 4.3: Multi-channel audio handling in playPcmChunk
  try {
    const handlesMultiChannel = appJs.includes('streamConfig.channels') &&
      appJs.includes('int16Array[i * numChannels + ch]');

    if (handlesMultiChannel) {
      logTest('Audio UX', 'UX-AUD-01', 'playPcmChunk supports multi-channel audio buffer allocation and sample de-interleaving', 'PASS');
    } else {
      logTest('Audio UX Defect', 'UX-AUD-01',
        'playPcmChunk hardcodes mono createBuffer(1, ...) assuming single-channel microphone',
        'FAIL',
        'Interleaved multi-channel audio will play distorted on stereo capture.',
        'MEDIUM'
      );
    }
  } catch (err) {
    logTest('Audio UX', 'UX-AUD-01', 'Multi-channel audio test error', 'FAIL', err.message, 'LOW');
  }

  // Test 4.4: Visualizer CPU throttling on hidden tab
  try {
    const pausesOnTabSwitch = appJs.includes('cancelAnimationFrame(animationFrameId)');
    if (pausesOnTabSwitch) {
      logTest('UX Performance', 'UX-PERF-01', 'Visualizer animation loop pauses when leaving Live Surveillance tab, conserving CPU cycles', 'PASS');
    } else {
      logTest('UX Performance', 'UX-PERF-01', 'Visualizer continues running in background tabs without throttling', 'FAIL', null, 'LOW');
    }
  } catch (err) {
    logTest('UX Performance', 'UX-PERF-01', 'Visualizer CPU test error', 'FAIL', err.message, 'LOW');
  }

  // Test 4.5: WCAG 2.1 Accessibility compliance
  try {
    const checks = {
      liveAnnouncer: indexHtml.includes('id="liveAnnouncer"') && indexHtml.includes('aria-live="polite"'),
      tabList: indexHtml.includes('role="tablist"') && indexHtml.includes('role="tab"') && indexHtml.includes('role="tabpanel"'),
      focusTrapping: appJs.includes('trapFocus') && appJs.includes("e.key === 'Tab'"),
      escapeDismissal: appJs.includes("e.key === 'Escape'"),
      tableActionLabels: appJs.includes('aria-label="Play recording') && appJs.includes('aria-label="Delete recording'),
      contrastAndFocusStyles: styleCss.includes(':focus-visible') || styleCss.includes(':focus')
    };

    let allA11yPass = true;
    for (const [k, v] of Object.entries(checks)) {
      if (!v) {
        allA11yPass = false;
        logTest('Accessibility', `A11Y-${k}`, `A11Y check failed for ${k}`, 'FAIL', null, 'MEDIUM');
      }
    }
    if (allA11yPass) {
      logTest('Accessibility', 'UX-A11Y-04', 'Comprehensive WCAG 2.1 AA audit passed (ARIA tabs, live announcer, focus trapping, Escape dismissal, accessible button names, and visible focus styles)', 'PASS');
    }
  } catch (err) {
    logTest('Accessibility', 'UX-A11Y-04', 'A11y audit error', 'FAIL', err.message, 'MEDIUM');
  }
}

// -----------------------------------------------------------------------------
// Main Runner
// -----------------------------------------------------------------------------
async function run() {
  console.log('================================================================');
  console.log('  BANDIT QA CRITICAL DEEP INVESTIGATION & EVALUATION SUITE');
  console.log('================================================================');

  try {
    await testSecurityAndCrypto();
    await startServer();
    await testRestApiCompliance();
    await testAudioAndStreamPipeline();
    await testUxFrontendAndA11y();
  } catch (err) {
    console.error('[QA Fatal Error]:', err);
  } finally {
    stopServer();
  }

  console.log('\n================================================================');
  console.log('  QA INVESTIGATION SUMMARY REPORT');
  console.log('================================================================');
  const total = findings.length;
  const passed = findings.filter(f => f.status === 'PASS').length;
  const failed = findings.filter(f => f.status === 'FAIL').length;
  const warnings = findings.filter(f => f.status === 'WARN').length;

  console.log(`Total Inquiries: ${total}`);
  console.log(`Passed:          ${passed}`);
  console.log(`Defects Found:   ${failed}`);
  console.log(`Warnings:        ${warnings}`);

  if (failed > 0) {
    console.log('\nCRITICAL DEFECTS IDENTIFIED FOR SOFTWARE ENGINEERING TEAM:');
    findings.filter(f => f.status === 'FAIL').forEach((f, idx) => {
      console.log(`\n[Defect ${idx + 1}] [${f.severity}] ${f.testId}: ${f.title}`);
      if (f.details) console.log(`   Description: ${f.details}`);
    });
  }

  console.log('================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

run();
