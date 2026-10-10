/**
 * Bandit EasyEffects DSP Audio Engine Automated Test Suite
 * Tests preset enumeration, switching, FFmpeg filter graph generation, and live filtered streaming.
 */

const http = require('http');
const { WebSocket } = require('ws');
const { spawn } = require('child_process');

const TEST_PORT = process.env.TEST_PORT || '8082';
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/stream`;
const TEST_TOKEN = 'bandit123';

function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}${path}`, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

function httpPost(path, body = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${BASE_URL}${path}`, {
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
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function ensureServerRunning() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await httpGet('/api/status');
      return null;
    } catch {}

    await new Promise(r => setTimeout(r, 800));

    console.log(`[Test Setup] Starting server instance (attempt ${attempt})...`);
    const serverProc = spawn('node', ['server.js'], {
      cwd: __dirname + '/..',
      stdio: 'inherit',
      env: { ...process.env, PORT: TEST_PORT }
    });

    let exitedEarly = false;
    serverProc.on('exit', () => { exitedEarly = true; });

    for (let i = 0; i < 25; i++) {
      if (exitedEarly) break;
      await new Promise(r => setTimeout(r, 200));
      try {
        await httpGet('/api/status');
        console.log('[Test Setup] Server is ready.');
        return serverProc;
      } catch {}
    }

    if (attempt === 3) {
      throw new Error('Server failed to start after 3 attempts');
    }
  }
}

async function runDspTests() {
  console.log('--- STARTING EASYEFFECTS DSP VERIFICATION ---\n');
  const spawnedServer = await ensureServerRunning();
  let failures = 0;

  // Test 1: Query DSP Presets
  try {
    const res = await httpGet('/api/dsp/presets');
    if (res.status === 200 && Array.isArray(res.body.presets) && res.body.presets.length >= 4) {
      console.log(`✅ Test 1 Passed: /api/dsp/presets returned ${res.body.presets.length} presets (Active: ${res.body.currentPreset})`);
    } else {
      console.error('❌ Test 1 Failed:', res.body);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 1 Error:', err.message);
    failures++;
  }

  // Test 2: Switch to Whisper Surveillance Preset
  try {
    const res = await httpPost('/api/dsp/preset', { preset: 'whisper' }, { Authorization: `Bearer ${TEST_TOKEN}` });
    if (res.status === 200 && res.body.preset === 'whisper' && res.body.activeFilterString.includes('speechnorm')) {
      console.log('✅ Test 2 Passed: Switched to "whisper" preset. Active filters:', res.body.activeFilterString);
    } else {
      console.error('❌ Test 2 Failed:', res.body);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 2 Error:', err.message);
    failures++;
  }

  // Test 3: Switch to Extreme Noise Rejection Preset
  try {
    const res = await httpPost('/api/dsp/preset', { preset: 'noise_rejection' }, { Authorization: `Bearer ${TEST_TOKEN}` });
    if (res.status === 200 && res.body.preset === 'noise_rejection' && res.body.activeFilterString.includes('agate')) {
      console.log('✅ Test 3 Passed: Switched to "noise_rejection" preset. Active filters:', res.body.activeFilterString);
    } else {
      console.error('❌ Test 3 Failed:', res.body);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 3 Error:', err.message);
    failures++;
  }

  // Test 4: Switch to Raw Bypass Preset
  try {
    const res = await httpPost('/api/dsp/preset', { preset: 'raw' }, { Authorization: `Bearer ${TEST_TOKEN}` });
    if (res.status === 200 && res.body.preset === 'raw' && res.body.activeFilterString === null) {
      console.log('✅ Test 4 Passed: Switched to "raw" bypass preset (No filter string)');
    } else {
      console.error('❌ Test 4 Failed:', res.body);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 4 Error:', err.message);
    failures++;
  }

  // Test 5: Switch back to Broadcast Preset & Verify WebSocket Live Streaming
  try {
    const switchRes = await httpPost('/api/dsp/preset', { preset: 'broadcast' }, { Authorization: `Bearer ${TEST_TOKEN}` });
    if (switchRes.status !== 200) {
      throw new Error('Failed to set broadcast preset');
    }

    const ws = new WebSocket(`${WS_URL}?token=${TEST_TOKEN}`);
    let receivedInit = false;
    let receivedDspChanged = false;
    let audioChunks = 0;
    let totalBytes = 0;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket DSP test timed out after 7 seconds'));
      }, 7000);

      ws.on('open', () => {
        // Send a preset switch message over WebSocket
        ws.send(JSON.stringify({ type: 'set_dsp_preset', preset: 'whisper' }));
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'init') {
              receivedInit = true;
            } else if (msg.type === 'dsp_changed') {
              receivedDspChanged = true;
            }
          } catch {}
        } else {
          audioChunks++;
          totalBytes += data.length;
          if (audioChunks >= 5 && receivedInit) {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    console.log(`✅ Test 5 Passed: WebSocket streamed ${audioChunks} filtered PCM frames (${totalBytes} bytes) with active DSP!`);
  } catch (err) {
    console.error('❌ Test 5 Error:', err.message);
    failures++;
  }

  console.log('\n-------------------------------------------');
  if (spawnedServer) {
    await new Promise((resolve) => {
      spawnedServer.on('exit', resolve);
      try { spawnedServer.kill('SIGTERM'); } catch { resolve(); }
      setTimeout(resolve, 1500);
    });
  }

  if (failures === 0) {
    console.log('🎉 ALL EASYEFFECTS DSP TESTS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } else {
    console.error(`⚠️ ${failures} DSP TEST(S) FAILED!\n`);
    process.exit(1);
  }
}

runDspTests();
