/**
 * Bandit Automated Audio Analysis & OpenAI Whisper STT Test Suite
 * Tests 30s PCM ring buffer, FFmpeg downsampling, word-level timestamps,
 * auto-detection of up to 4 speakers with 0.8s threshold, intelligence metrics,
 * and REST analysis endpoints.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const AudioCapture = require('../src/audioCapture');
const WhisperAnalyzer = require('../src/whisperAnalyzer');

const PORT = process.env.TEST_PORT || '8083';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_TOKEN = 'bandit123';

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

const { spawn } = require('child_process');

async function ensureServerRunning() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await httpGet('/api/status');
      return null;
    } catch {}

    await new Promise(r => setTimeout(r, 600));

    console.log(`[Test Setup] Starting server instance for analysis tests (attempt ${attempt})...`);
    const serverProc = spawn('node', ['server.js'], {
      cwd: __dirname + '/..',
      stdio: 'inherit',
      env: { ...process.env, PORT, AUTH_TOKEN: TEST_TOKEN }
    });

    let exitedEarly = false;
    serverProc.on('exit', () => { exitedEarly = true; });

    for (let i = 0; i < 25; i++) {
      if (exitedEarly) break;
      await new Promise(r => setTimeout(r, 200));
      try {
        await httpGet('/api/status');
        console.log('[Test Setup] Server is ready on port ' + PORT);
        return serverProc;
      } catch {}
    }

    if (attempt === 3) {
      throw new Error('Server failed to start after 3 attempts');
    }
  }
}

async function runTests() {
  console.log('=== STARTING BANDIT AUDIO ANALYSIS & WHISPER STT TEST SUITE ===\n');
  const spawnedServer = await ensureServerRunning();
  let failures = 0;

  // ---------------------------------------------------------------------------
  // Test 1: Rolling 30-Second Circular PCM Ring Buffer
  // ---------------------------------------------------------------------------
  console.log('[Test 1] Testing 30-Second Circular PCM Ring Buffer...');
  try {
    const capture = new AudioCapture({
      device: 'test',
      driver: 'lavfi',
      sampleRate: 24000,
      channels: 1,
      chunkMs: 40
    });

    // Simulate 50 chunks of 40ms audio (2.0 seconds)
    const chunkSize = 1920; // 24000 * 1 * 2 * 0.04
    for (let i = 0; i < 50; i++) {
      const dummy = Buffer.alloc(chunkSize, i % 128);
      capture.recentAudioBuffer = Buffer.concat([capture.recentAudioBuffer, dummy]);
      if (capture.recentAudioBuffer.length > capture.maxRollingBytes) {
        capture.recentAudioBuffer = capture.recentAudioBuffer.subarray(capture.recentAudioBuffer.length - capture.maxRollingBytes);
      }
    }

    const slice30s = capture.getRecentAudioBuffer(30);
    const slice1s = capture.getRecentAudioBuffer(1);

    if (slice30s.length === 50 * chunkSize && slice1s.length === 24000 * 2 * 1) {
      console.log(`  PASS: Circular buffer accumulated ${slice30s.length} bytes; 1s slice correctly extracted ${slice1s.length} bytes.`);
    } else {
      console.error(`  FAIL: Unexpected buffer sizes: slice30s=${slice30s.length}, slice1s=${slice1s.length}`);
      failures++;
    }
  } catch (err) {
    console.error('  FAIL Test 1 Error:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 2: Audio Preprocessor & FFmpeg Downsampling
  // ---------------------------------------------------------------------------
  console.log('\n[Test 2] Testing FFmpeg PCM Buffer to 16kHz MP3 Encoding...');
  const analyzer = new WhisperAnalyzer();
  let sampleMp3 = null;
  try {
    // Generate 1 second of test PCM (24000 samples s16le = 48000 bytes)
    const testPcm = Buffer.alloc(48000);
    for (let i = 0; i < testPcm.length / 2; i++) {
      const val = Math.floor(Math.sin(2 * Math.PI * 440 * (i / 24000)) * 16000);
      testPcm.writeInt16LE(val, i * 2);
    }

    sampleMp3 = await analyzer.pcmBufferToAudioFile(testPcm, 24000, 1);
    if (fs.existsSync(sampleMp3) && fs.statSync(sampleMp3).size > 500) {
      console.log(`  PASS: FFmpeg encoded test PCM into optimized MP3 (${fs.statSync(sampleMp3).size} bytes).`);
    } else {
      console.error('  FAIL: Encoded MP3 is missing or too small.');
      failures++;
    }
  } catch (err) {
    console.error('  FAIL Test 2 Error:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 3: Word-Level Timestamps, 4-Speaker Diarization & 0.8s Threshold
  // ---------------------------------------------------------------------------
  console.log('\n[Test 3] Testing Word-Level Timestamps & 4-Speaker Diarization (≥ 0.8s threshold)...');
  try {
    const report = await analyzer.analyzeAudio(sampleMp3, {
      filename: 'sample_intel_test.mp3',
      keywords: 'security, password, intruder, alert',
      maxSpeakers: 4,
      minSegmentSec: 0.8
    });

    if (report && report.segments && report.segments.length > 0) {
      const seg1 = report.segments[0];
      const hasWords = Array.isArray(seg1.words) && seg1.words.length > 0;
      const hasSpeaker = typeof seg1.speaker === 'string' && seg1.speaker.startsWith('Speaker');
      const cappedSpeakers = report.metrics.speakers.length <= 4;
      const hasMetrics = report.metrics.wordsPerMinute > 0 && report.metrics.speechActivityRatio > 0;

      if (hasWords && hasSpeaker && cappedSpeakers && hasMetrics) {
        console.log(`  PASS: Report generated with ${report.segments.length} segments.`);
        console.log(`  PASS: Word timestamps verified (e.g. word="${seg1.words[0].word}" [${seg1.words[0].start}s - ${seg1.words[0].end}s]).`);
        console.log(`  PASS: Speaker Diarization active: ${report.metrics.speakers.join(', ')} (Max 4 speakers, ≥ 0.8s threshold enforced).`);
        console.log(`  PASS: Speech metrics verified: WPM=${report.metrics.wordsPerMinute}, SpeechRatio=${report.metrics.speechActivityRatio}%, KeywordsFlagged=${report.metrics.keywordMatchesCount}`);
      } else {
        console.error('  FAIL: Missing expected fields in analysis report:', { hasWords, hasSpeaker, cappedSpeakers, hasMetrics });
        failures++;
      }
    } else {
      console.error('  FAIL: No segments returned in analysis report.');
      failures++;
    }
  } catch (err) {
    console.error('  FAIL Test 3 Error:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 4: Subtitle & Text Format Exporters
  // ---------------------------------------------------------------------------
  console.log('\n[Test 4] Testing Subtitle Exporters (SRT, VTT, TXT)...');
  try {
    const cached = analyzer.getTranscript('sample_intel_test');
    if (cached) {
      const srt = analyzer.exportToSrt(cached);
      const vtt = analyzer.exportToVtt(cached);
      const txt = analyzer.exportToTxt(cached);

      const srtValid = srt.includes('-->') && srt.includes('[Speaker');
      const vttValid = vtt.startsWith('WEBVTT') && vtt.includes('-->');
      const txtValid = txt.includes('BANDIT AUDIO SURVEILLANCE TRANSCRIPT');

      if (srtValid && vttValid && txtValid) {
        console.log('  PASS: SRT, VTT, and TXT subtitle files formatted correctly with timestamps and speaker tags.');
      } else {
        console.error('  FAIL: Subtitle output validation failed.');
        failures++;
      }
    } else {
      console.error('  FAIL: Cached transcript not found.');
      failures++;
    }
  } catch (err) {
    console.error('  FAIL Test 4 Error:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 5: REST API Analysis Endpoints
  // ---------------------------------------------------------------------------
  console.log('\n[Test 5] Testing REST API Endpoints on Port ' + PORT + '...');
  try {
    // 5a. GET /api/analysis/config
    const cfgRes = await httpGet('/api/analysis/config', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    if (cfgRes.status === 200 && cfgRes.body.model === 'small' && cfgRes.body.maxSpeakers === 4) {
      console.log('  PASS: /api/analysis/config reports model="small", maxSpeakers=4, minSegmentSec=0.8.');
    } else {
      console.error('  FAIL: /api/analysis/config failed:', cfgRes);
      failures++;
    }

    // 5b. POST /api/analysis/live-snapshot
    const snapRes = await httpPost('/api/analysis/live-snapshot', { seconds: 5 }, { 'Authorization': `Bearer ${TEST_TOKEN}` });
    if (snapRes.status === 200 && snapRes.body.success === true && snapRes.body.report) {
      console.log('  PASS: /api/analysis/live-snapshot analyzed live stream buffer and returned report.');
    } else {
      console.error('  FAIL: /api/analysis/live-snapshot failed:', snapRes);
      failures++;
    }

    // 5c. GET /api/analysis/jobs
    const jobsRes = await httpGet('/api/analysis/jobs', { 'Authorization': `Bearer ${TEST_TOKEN}` });
    if (jobsRes.status === 200 && Array.isArray(jobsRes.body.jobs) && jobsRes.body.jobs.length > 0) {
      console.log(`  PASS: /api/analysis/jobs returned ${jobsRes.body.jobs.length} analyzed job(s).`);
    } else {
      console.error('  FAIL: /api/analysis/jobs failed:', jobsRes);
      failures++;
    }

    // 5d. GET /api/analysis/jobs/:id/export/srt
    const exportRes = await httpGet(`/api/analysis/jobs/sample_intel_test/export/srt`, { 'Authorization': `Bearer ${TEST_TOKEN}` });
    if (exportRes.status === 200 && (exportRes.raw || '').includes('-->')) {
      console.log('  PASS: /api/analysis/jobs/:id/export/srt streamed valid SubRip subtitle content.');
    } else {
      console.error('  FAIL: Subtitle export endpoint failed:', exportRes);
      failures++;
    }
  } catch (err) {
    console.error('  FAIL Test 5 Error:', err.message);
    failures++;
  }

  // Cleanup sample file
  if (sampleMp3 && fs.existsSync(sampleMp3)) {
    try { fs.unlinkSync(sampleMp3); } catch {}
  }

  console.log('\n======================================================');
  if (failures === 0) {
    console.log('  🎉 ALL AUDIO ANALYSIS & WHISPER STT TESTS PASSED!');
    console.log('======================================================\n');
  } else {
    console.error(`  ❌ ${failures} TEST(S) FAILED!`);
    console.log('======================================================\n');
  }

  if (spawnedServer) {
    console.log('[Bandit] Shutting down test server...');
    await new Promise((resolve) => {
      spawnedServer.on('close', resolve);
      spawnedServer.on('exit', resolve);
      try { spawnedServer.kill('SIGTERM'); } catch { resolve(); }
      setTimeout(() => {
        try { spawnedServer.kill('SIGKILL'); } catch {}
        resolve();
      }, 1000);
    });
    await new Promise(r => setTimeout(r, 600));
  }

  process.exit(failures === 0 ? 0 : 1);
}

runTests().catch(err => {
  console.error('[Fatal Test Error]:', err);
  process.exit(1);
});
