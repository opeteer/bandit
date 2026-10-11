/**
 * Bandit Microphone Listing & Selection Automated Test Suite
 * Tests device scanning, REST endpoints (/api/devices, /api/devices/scan, /api/capture/device),
 * and WebSocket protocol (init frame, get_devices, switch_device, scan_devices).
 */

const http = require('http');
const { WebSocket } = require('ws');
const { spawn } = require('child_process');
const { scanAudioDevices } = require('../src/deviceScanner');

const TEST_PORT = process.env.TEST_PORT || '8084';
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

    console.log(`[Test Setup] Starting server instance for mic tests (attempt ${attempt})...`);
    const serverProc = spawn('node', ['server.js'], {
      cwd: __dirname + '/..',
      stdio: 'inherit',
      env: { ...process.env, PORT: TEST_PORT, AUTH_TOKEN: TEST_TOKEN }
    });

    let exitedEarly = false;
    serverProc.on('exit', () => { exitedEarly = true; });

    for (let i = 0; i < 25; i++) {
      if (exitedEarly) break;
      await new Promise(r => setTimeout(r, 200));
      try {
        await httpGet('/api/status');
        console.log('[Test Setup] Server is ready on port ' + TEST_PORT);
        return serverProc;
      } catch {}
    }

    if (attempt === 3) {
      throw new Error('Server failed to start after 3 attempts');
    }
  }
}

async function runMicSelectorTests() {
  console.log('\n=== STARTING BANDIT MICROPHONE SELECTOR TEST SUITE ===\n');

  // Test 1: Device Scanner Unit Verification
  console.log('[Test 1] Testing device scanner enumeration...');
  const scanned = scanAudioDevices();
  if (Array.isArray(scanned) && scanned.length > 0) {
    const hasTest = scanned.some(d => d.id === 'test');
    if (hasTest) {
      console.log(`  PASS: scanAudioDevices returned ${scanned.length} device(s) including synthetic test generator.`);
    } else {
      console.error('  FAIL: scanAudioDevices did not contain test option.');
      process.exit(1);
    }
  } else {
    console.error('  FAIL: scanAudioDevices returned empty array.');
    process.exit(1);
  }

  const spawnedServer = await ensureServerRunning();
  let failures = 0;

  // Test 2: GET /api/devices REST endpoint
  console.log('\n[Test 2] Testing GET /api/devices with auth token...');
  try {
    const res = await httpGet(`/api/devices?token=${TEST_TOKEN}`);
    if (res.status === 200 && Array.isArray(res.body.devices)) {
      const activeDev = res.body.devices.find(d => d.isActive);
      console.log(`  PASS: GET /api/devices returned ${res.body.devices.length} devices.`);
      console.log(`  PASS: Current device: "${res.body.currentDevice}" (Name: ${res.body.currentDeviceName}).`);
      if (activeDev) {
        console.log(`  PASS: Active device flag verified: ${activeDev.id}`);
      }
    } else {
      console.error('  FAIL: GET /api/devices failed:', res);
      failures++;
    }
  } catch (err) {
    console.error('  FAIL: GET /api/devices error:', err.message);
    failures++;
  }

  // Test 3: POST /api/devices/scan Rescan Endpoint
  console.log('\n[Test 3] Testing POST /api/devices/scan rescan endpoint...');
  try {
    const res = await httpPost('/api/devices/scan', {}, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    if (res.status === 200 && Array.isArray(res.body.devices)) {
      console.log(`  PASS: Rescan endpoint returned ${res.body.devices.length} devices.`);
    } else {
      console.error('  FAIL: POST /api/devices/scan failed:', res);
      failures++;
    }
  } catch (err) {
    console.error('  FAIL: POST /api/devices/scan error:', err.message);
    failures++;
  }

  // Test 4: Switching Device via REST to 'test' generator
  console.log('\n[Test 4] Testing POST /api/capture/device to switch to synthetic test mic...');
  try {
    const res = await httpPost('/api/capture/device', { device: 'test', driver: 'lavfi' }, {
      'Authorization': `Bearer ${TEST_TOKEN}`
    });
    if (res.status === 200 && res.body.success && res.body.device === 'test') {
      console.log(`  PASS: Switched to test mic: "${res.body.deviceName}"`);
    } else {
      console.error('  FAIL: POST /api/capture/device switch to test failed:', res);
      failures++;
    }
  } catch (err) {
    console.error('  FAIL: POST /api/capture/device error:', err.message);
    failures++;
  }

  // Test 5: Verify device state updated via GET /api/status and GET /api/devices
  console.log('\n[Test 5] Verifying system telemetry updated with active test mic...');
  try {
    const res = await httpGet(`/api/status?token=${TEST_TOKEN}`);
    if (res.status === 200 && (res.body.audio?.device === 'test' || res.body.audio?.driver === 'lavfi')) {
      console.log(`  PASS: System status reports device "${res.body.audio.device}" (driver: ${res.body.audio.driver}).`);
    } else {
      console.error('  FAIL: System status did not reflect switch to test mic:', res.body.audio);
      failures++;
    }
  } catch (err) {
    console.error('  FAIL: Status check error:', err.message);
    failures++;
  }

  // Test 6: Switching Device via WebSocket
  console.log('\n[Test 6] Testing WebSocket mic protocol (init frame, get_devices, switch_device)...');
  await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}?token=${TEST_TOKEN}`);
    let receivedInitDevices = false;
    let receivedDevicesList = false;
    let receivedDeviceChanged = false;

    ws.on('open', () => {
      // Step 6a: wait for init
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'init') {
          if (Array.isArray(msg.devices) && msg.devices.length > 0) {
            receivedInitDevices = true;
            console.log(`  PASS: WebSocket 'init' frame contains ${msg.devices.length} devices.`);
          }
          // Request devices list explicitly
          ws.send(JSON.stringify({ type: 'get_devices' }));
        } else if (msg.type === 'devices_list') {
          if (Array.isArray(msg.devices)) {
            receivedDevicesList = true;
            console.log(`  PASS: WebSocket received 'devices_list' response with ${msg.devices.length} devices.`);
          }
          // Request switch device via WebSocket to 'default' or first physical candidate
          ws.send(JSON.stringify({ type: 'switch_device', device: 'default', driver: 'alsa' }));
        } else if (msg.type === 'device_changed') {
          receivedDeviceChanged = true;
          console.log(`  PASS: WebSocket received broadcast 'device_changed' event: ${msg.name || msg.device}`);
          ws.close();
          resolve();
        }
      } catch (e) {
        console.error('WS message parse error:', e);
      }
    });

    ws.on('error', (err) => {
      console.error('  FAIL: WebSocket error:', err.message);
      failures++;
      resolve();
    });

    // Timeout failsafe
    setTimeout(() => {
      if (!receivedDeviceChanged) {
        console.warn('  TIMEOUT: Did not receive all WebSocket device events in time.');
        failures++;
      }
      ws.close();
      resolve();
    }, 4500);
  });

  // Cleanup
  if (spawnedServer) {
    console.log('\n[Cleanup] Stopping test server instance...');
    spawnedServer.kill('SIGTERM');
  }

  console.log('\n======================================================');
  if (failures === 0) {
    console.log('  🎉 ALL MICROPHONE LISTING & SELECTION TESTS PASSED!');
    console.log('======================================================\n');
    process.exit(0);
  } else {
    console.error(`  ❌ ${failures} TEST(S) FAILED!`);
    console.log('======================================================\n');
    process.exit(1);
  }
}

runMicSelectorTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
