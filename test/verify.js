/**
 * Bandit Automated Verification Test Suite
 * Tests REST APIs, Auth Protection, WebSocket Streaming, and PCM Audio Chunks.
 */

const http = require('http');
const { WebSocket } = require('ws');

const PORT = process.env.PORT || '8099';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/stream`;
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

const { spawn } = require('child_process');

async function ensureServerRunning() {
  try {
    await httpGet('/api/status');
    return null; // Already running
  } catch {
    console.log('[Test Setup] Starting server instance for verification...');
    const serverProc = spawn('node', ['server.js'], {
      cwd: __dirname + '/..',
      stdio: 'inherit'
    });
    // Wait for server to bind
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        await httpGet('/api/status');
        console.log('[Test Setup] Server is ready.');
        return serverProc;
      } catch {
        // waiting
      }
    }
    throw new Error('Server failed to start within 4 seconds');
  }
}

async function runTests() {
  console.log('--- STARTING BANDIT SYSTEM VERIFICATION ---\n');
  const spawnedServer = await ensureServerRunning();
  let failures = 0;

  // Test 1: Status endpoint without token
  try {
    const res = await httpGet('/api/status');
    if (res.status === 200 && res.body.authRequired === true && res.body.isAuthenticated === false) {
      console.log('✅ Test 1 Passed: /api/status indicates authRequired=true and isAuthenticated=false');
    } else {
      console.error('❌ Test 1 Failed:', res);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 1 Error:', err.message);
    failures++;
  }

  // Test 2: Status endpoint with valid token
  try {
    const res = await httpGet(`/api/status?token=${TEST_TOKEN}`);
    if (res.status === 200 && res.body.isAuthenticated === true) {
      console.log('✅ Test 2 Passed: /api/status with token reports isAuthenticated=true');
    } else {
      console.error('❌ Test 2 Failed:', res);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 2 Error:', err.message);
    failures++;
  }

  // Test 3: Auth verification API
  try {
    const invalidRes = await httpPost('/api/auth/verify', { token: 'wrong-token' });
    const validRes = await httpPost('/api/auth/verify', { token: TEST_TOKEN });
    if (invalidRes.body.valid === false && validRes.body.valid === true) {
      console.log('✅ Test 3 Passed: /api/auth/verify accurately differentiates valid vs invalid tokens');
    } else {
      console.error('❌ Test 3 Failed:', invalidRes.body, validRes.body);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 3 Error:', err.message);
    failures++;
  }

  // Test 4: Devices list endpoint with Bearer auth
  try {
    const res = await httpGet('/api/devices', { Authorization: `Bearer ${TEST_TOKEN}` });
    if (res.status === 200 && Array.isArray(res.body.devices) && res.body.devices.length > 0) {
      console.log(`✅ Test 4 Passed: /api/devices returned ${res.body.devices.length} audio input device options`);
    } else {
      console.error('❌ Test 4 Failed:', res);
      failures++;
    }
  } catch (err) {
    console.error('❌ Test 4 Error:', err.message);
    failures++;
  }

  // Test 5: WebSocket connection with valid token
  try {
    const ws = new WebSocket(`${WS_URL}?token=${TEST_TOKEN}`);
    let receivedInit = false;
    let receivedPong = false;
    let audioChunks = 0;
    let totalBytes = 0;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket test timed out after 6 seconds'));
      }, 6000);

      ws.on('open', () => {
        // Send a ping message
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'init') {
              receivedInit = true;
            } else if (msg.type === 'pong') {
              receivedPong = true;
            }
          } catch {
            // ignore
          }
        } else {
          // Binary audio packet
          audioChunks++;
          totalBytes += data.length;
          if (audioChunks >= 5 && receivedInit && receivedPong) {
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

    console.log(`✅ Test 5 Passed: WebSocket stream active! Received init, pong, and ${audioChunks} PCM binary frames (${totalBytes} bytes)`);
  } catch (err) {
    console.error('❌ Test 5 Error:', err.message);
    failures++;
  }

  console.log('\n-------------------------------------------');
  if (spawnedServer) {
    await new Promise((resolve) => {
      spawnedServer.on('exit', resolve);
      try { spawnedServer.kill('SIGTERM'); } catch { resolve(); }
      setTimeout(() => {
        try { spawnedServer.kill('SIGKILL'); } catch {}
        resolve();
      }, 1000);
    });
    await new Promise(r => setTimeout(r, 600));
  }
  if (failures === 0) {
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } else {
    console.error(`⚠️ ${failures} TEST(S) FAILED!`);
    process.exit(1);
  }
}

runTests();
