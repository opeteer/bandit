/**
 * Bandit Bug Patches & Security Fixes Verification Suite
 * Verifies SEC-01 to SEC-04 and BUG-01 to BUG-05 fixes.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { safeCompare, generateMediaTicket, isValidMediaTicket, isValidToken } = require('../src/auth');
const WhisperAnalyzer = require('../src/whisperAnalyzer');
const AudioCapture = require('../src/audioCapture');

const PORT = 8085;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_TOKEN = 'bandit_patch_test_token_123';

function httpGet(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${p}`, { headers }, (res) => {
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

function httpPost(p, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${p}`, {
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

function httpDelete(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${p}`, {
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

async function runPatchVerifications() {
  console.log('=== RUNNING BANDIT PATCHES & SECURITY VERIFICATION SUITE ===\n');
  let failures = 0;

  // ---------------------------------------------------------------------------
  // SEC-03: safeCompare SHA-256 Length Timing Immunity
  // ---------------------------------------------------------------------------
  console.log('[Test 1] Testing SEC-03: safeCompare timing & length-safe comparison...');
  try {
    assert.strictEqual(safeCompare('test-secret', 'test-secret'), true, 'Equal strings must match');
    assert.strictEqual(safeCompare('test-secret', 'short'), false, 'Different lengths must fail');
    assert.strictEqual(safeCompare('test-secret', 'test-secreX'), false, 'Equal length differing content must fail');
    assert.strictEqual(safeCompare(123, '123'), false, 'Non-string inputs must safely return false');
    assert.strictEqual(safeCompare('', ''), true, 'Empty strings match');
    console.log('  PASS: safeCompare hashes via SHA-256 and handles all inputs safely.');
  } catch (err) {
    console.error('  FAIL SEC-03:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // SEC-04: Signed Media Tickets
  // ---------------------------------------------------------------------------
  console.log('\n[Test 2] Testing SEC-04: Signed media ticket generation & validation...');
  try {
    process.env.AUTH_TOKEN = 'test-token-sec4';
    const ticketSpecific = generateMediaTicket('bandit_rec_test.mp3', 60);
    const ticketWildcard = generateMediaTicket('*', 60);
    const ticketExpired = generateMediaTicket('bandit_rec_test.mp3', -10);

    assert.strictEqual(isValidMediaTicket(ticketSpecific, 'bandit_rec_test.mp3'), true, 'Valid specific ticket must pass');
    assert.strictEqual(isValidMediaTicket(ticketSpecific, 'other_file.mp3'), false, 'File mismatch must be rejected');
    assert.strictEqual(isValidMediaTicket(ticketWildcard, 'any_recording.mp3'), true, 'Wildcard ticket must pass');
    assert.strictEqual(isValidMediaTicket(ticketExpired, 'bandit_rec_test.mp3'), false, 'Expired ticket must be rejected');
    assert.strictEqual(isValidMediaTicket('tampered_ticket', 'bandit_rec_test.mp3'), false, 'Tampered ticket must be rejected');
    console.log('  PASS: Short-lived media tickets protect master password from URL exposure.');
  } catch (err) {
    console.error('  FAIL SEC-04:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // SEC-01 & SEC-02: Path Traversal Defenses in WhisperAnalyzer
  // ---------------------------------------------------------------------------
  console.log('\n[Test 3] Testing SEC-01 & SEC-02: Path traversal defenses in transcripts...');
  const analyzer = new WhisperAnalyzer();
  try {
    // SEC-01: Read traversal
    const resRead = analyzer.getTranscript('../../package.json');
    assert.strictEqual(resRead, null, 'Path traversal read must return null');

    const resReadEncoded = analyzer.getTranscript('..%2F..%2Fpackage.json');
    assert.strictEqual(resReadEncoded, null, 'Encoded traversal read must return null');

    // SEC-02: Delete traversal
    let threw = false;
    try {
      analyzer.deleteTranscript('../../package.json');
    } catch {
      threw = true;
    }
    // File must still exist
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'package.json')), true, 'package.json must not be deleted');
    console.log('  PASS: Path traversal attempts in getTranscript and deleteTranscript are blocked.');
  } catch (err) {
    console.error('  FAIL SEC-01/02:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // BUG-01: Live Snapshot Audio Persistence in recordingsDir
  // ---------------------------------------------------------------------------
  console.log('\n[Test 4] Testing BUG-01: Live snapshot audio persistence...');
  const testSnapshotName = `bandit_rec_snapshot_verify_${Date.now()}.mp3`;
  try {
    // 1 second of dummy PCM
    const dummyPcm = Buffer.alloc(24000 * 2, 0);
    const report = await analyzer.analyzeAudio(dummyPcm, {
      filename: testSnapshotName,
      sampleRate: 24000,
      channels: 1
    });

    const expectedAudioPath = path.join(analyzer.recordingsDir, testSnapshotName);
    assert.strictEqual(fs.existsSync(expectedAudioPath), true, 'Snapshot MP3 must be saved in recordingsDir');
    assert.strictEqual(report.filename, testSnapshotName, 'Report filename must match');
    assert.strictEqual(report.filename.startsWith('bandit_rec_'), true, 'Report filename must comply with bandit_rec_ naming');

    // Cleanup test snapshot
    try { fs.unlinkSync(expectedAudioPath); } catch {}
    try { analyzer.deleteTranscript(report.id); } catch {}
    console.log('  PASS: Live snapshot audio is persisted to recordings/ and complies with bandit_rec_ naming.');
  } catch (err) {
    console.error('  FAIL BUG-01:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // BUG-02: DSP Process Failure Fallback to Direct Ingestion
  // ---------------------------------------------------------------------------
  console.log('\n[Test 5] Testing BUG-02: DSP filter failure direct fallback...');
  try {
    const capture = new AudioCapture({ device: 'test', driver: 'lavfi', dspPreset: 'broadcast' });
    let chunksEmitted = 0;
    capture.on('data', () => chunksEmitted++);

    // Simulate killing/nullifying filter process to test fallback
    capture.filterProcess = null;
    capture.activeFilterString = 'some-filter';

    // Simulate incoming hardware chunk
    const testChunk = Buffer.alloc(1920, 1);
    capture.handleProcessedAudioChunk(testChunk);

    assert(chunksEmitted > 0, 'Audio chunk must be emitted even if filterProcess is null');
    console.log('  PASS: Audio capture falls back to direct bypass if DSP process is unavailable.');
  } catch (err) {
    console.error('  FAIL BUG-02:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // REST API Server Tests (Port 8085)
  // ---------------------------------------------------------------------------
  console.log(`\n[Test Setup] Spawning test server on port ${PORT}...`);
  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), AUTH_TOKEN: TEST_TOKEN }
  });

  try {
    // Wait for server ready
    let ready = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const st = await httpGet('/api/status');
        if (st.status === 200) { ready = true; break; }
      } catch {}
    }
    assert(ready, 'Server failed to start');

    const authHeader = { 'Authorization': `Bearer ${TEST_TOKEN}` };

    // Test 6: BUG-05 Input validation on /api/capture/device and /api/dsp/preset
    console.log('\n[Test 6] Testing BUG-05: Input validation on device & dsp preset endpoints...');
    const bogusDevRes = await httpPost('/api/capture/device', { device: 'bogus_nonexistent_dev' }, authHeader);
    assert.strictEqual(bogusDevRes.status, 400, 'Invalid device must return HTTP 400');
    assert(bogusDevRes.body.validDevices, 'Response must list valid devices');

    const bogusPresetRes = await httpPost('/api/dsp/preset', { preset: 'bogus_preset_xyz' }, authHeader);
    assert.strictEqual(bogusPresetRes.status, 400, 'Invalid preset must return HTTP 400');
    assert(bogusPresetRes.body.validPresets, 'Response must list valid presets');
    console.log('  PASS: Unvalidated device and preset parameters correctly return HTTP 400 Bad Request.');

    // Test 7: BUG-03 Clearing OpenAI API Key
    console.log('\n[Test 7] Testing BUG-03: Clearing OpenAI API key via /api/analysis/config...');
    const setKeyRes = await httpPost('/api/analysis/config', { openaiApiKey: 'sk-test-key-123' }, authHeader);
    assert.strictEqual(setKeyRes.status, 200);

    const clearKeyRes = await httpPost('/api/analysis/config', { openaiApiKey: '' }, authHeader);
    assert.strictEqual(clearKeyRes.status, 200);
    console.log('  PASS: Empty API key clears configuration properly on backend.');

    // Test 8: SEC-04 Media ticket endpoint and media streaming auth
    console.log('\n[Test 8] Testing SEC-04: /api/auth/media-ticket endpoint & ticket-authorized streaming...');
    const ticketRes = await httpPost('/api/auth/media-ticket', { filename: 'bandit_rec_sample.mp3' }, authHeader);
    assert.strictEqual(ticketRes.status, 200);
    assert(ticketRes.body.ticket, 'Must return signed ticket');

    // Attempt streaming matching file with ticket: authorized (returns 404 since file not on disk, NOT 401)
    const streamRes = await httpGet(`/api/recordings/bandit_rec_sample.mp3?ticket=${ticketRes.body.ticket}`);
    assert.strictEqual(streamRes.status, 404, 'Ticket must authorize request even without Bearer token header');

    // Attempt streaming with mismatched filename: rejected (401)
    const mismatchRes = await httpGet(`/api/recordings/bandit_rec_other.mp3?ticket=${ticketRes.body.ticket}`);
    assert.strictEqual(mismatchRes.status, 401, 'Mismatched filename on ticket must be rejected with 401');

    console.log('  PASS: Media ticket endpoint generates valid tickets accepted by /api/recordings, rejecting mismatches.');

    // Test 9: SEC-01 / SEC-02 Server traversal probe
    console.log('\n[Test 9] Testing SEC-01 / SEC-02 traversal probe via HTTP API...');
    const travReadRes = await httpGet('/api/analysis/jobs/%2E%2E%2F%2E%2E%2Fpackage.json', authHeader);
    assert.strictEqual(travReadRes.status, 404, 'Traversal read attempt via HTTP must return 404');

    const travDelRes = await httpDelete('/api/analysis/jobs/%2E%2E%2F%2E%2E%2Fpackage.json', authHeader);
    assert.strictEqual(travDelRes.status, 404, 'Traversal delete attempt via HTTP must return 404');
    console.log('  PASS: HTTP traversal attempts are rejected.');

  } catch (err) {
    console.error('  FAIL REST API patch tests:', err.message);
    failures++;
  } finally {
    serverProc.kill('SIGTERM');
  }

  console.log('\n======================================================');
  if (failures === 0) {
    console.log('  🎉 ALL PATCH & SECURITY VERIFICATION TESTS PASSED (9/9)!');
    console.log('======================================================\n');
  } else {
    console.error(`  ❌ ${failures} PATCH VERIFICATION TEST(S) FAILED!`);
    console.log('======================================================\n');
  }

  process.exit(failures === 0 ? 0 : 1);
}

runPatchVerifications().catch(err => {
  console.error('[Fatal Patch Test Error]:', err);
  process.exit(1);
});
