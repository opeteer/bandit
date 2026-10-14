/**
 * Bandit USB Microphone & ALSA PlugHW Automated Verification Suite
 * Verifies fixes for:
 * 1. ALSA plughw device enumeration and USB device prioritization
 * 2. Input demuxer -channels and -sample_rate placement before -i
 * 3. hw: to plughw: normalization preventing channel count rejection (EINVAL)
 * 4. Prevention of unwanted failover switches to Card 0 onboard floating analog noise
 * 5. Interchangeable hw: and plughw: device ID matching across API and WebSockets
 */

const assert = require('assert');
const { scanAudioDevices, findAvailableMicrophone, getDeviceDisplayName } = require('../src/deviceScanner');
const AudioCapture = require('../src/audioCapture');

async function runTests() {
  console.log('=== RUNNING BANDIT USB MICROPHONE & ALSA PATCH VERIFICATION ===\n');
  let failures = 0;

  // ---------------------------------------------------------------------------
  // Test 1: Device Scanner Enumeration & plughw Generation
  // ---------------------------------------------------------------------------
  console.log('[Test 1] Testing ALSA hardware enumeration uses plughw and tags USB devices...');
  try {
    const devices = scanAudioDevices(true);
    assert(Array.isArray(devices) && devices.length > 0, 'Devices list must be non-empty');

    const alsaHwDevices = devices.filter(d => d.driver === 'alsa' && d.id !== 'default');
    if (alsaHwDevices.length > 0) {
      const allPlugHw = alsaHwDevices.every(d => d.id.startsWith('plughw:'));
      assert(allPlugHw, `All ALSA hardware devices must use plughw: prefix, found: ${alsaHwDevices.map(d => d.id).join(', ')}`);
      console.log(`  PASS: ALSA hardware devices use plughw: (${alsaHwDevices.map(d => d.id).join(', ')})`);

      const usbMics = alsaHwDevices.filter(d => d.isUsb);
      if (usbMics.length > 0) {
        console.log(`  PASS: Detected and tagged USB audio hardware: "${usbMics[0].name}" (${usbMics[0].id})`);
      }
    } else {
      console.log('  INFO: No physical ALSA soundcards found in current environment (test tone present).');
    }
  } catch (err) {
    console.error('  FAIL Test 1:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 2: findAvailableMicrophone Prioritizes USB Mics over Onboard Cards
  // ---------------------------------------------------------------------------
  console.log('\n[Test 2] Testing findAvailableMicrophone prioritizes USB microphones...');
  try {
    const candidate = findAvailableMicrophone();
    if (candidate) {
      console.log(`  PASS: Auto-detected mic candidate: "${candidate.name}" (${candidate.id})`);
      const devices = scanAudioDevices();
      const hasUsb = devices.some(d => d.isUsb);
      if (hasUsb) {
        assert(candidate.isUsb || candidate.name.toLowerCase().includes('usb'),
          `When USB mic is present, candidate must be a USB mic. Got: ${candidate.name} (${candidate.id})`);
        console.log('  PASS: Dedicated USB microphone correctly prioritized over onboard analog inputs.');
      }
    }
  } catch (err) {
    console.error('  FAIL Test 2:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 3: findAvailableMicrophone Normalizes hw: and plughw: Identifiers
  // ---------------------------------------------------------------------------
  console.log('\n[Test 3] Testing preferredDevice matching handles hw: and plughw: interchangeably...');
  try {
    const devices = scanAudioDevices();
    const plugDev = devices.find(d => d.id.startsWith('plughw:'));
    if (plugDev) {
      const hwEquivalent = plugDev.id.replace('plughw:', 'hw:');

      // Requesting by hw: must find the plughw: device
      const matchedByHw = findAvailableMicrophone(hwEquivalent);
      assert.strictEqual(matchedByHw?.id, plugDev.id,
        `findAvailableMicrophone("${hwEquivalent}") must match "${plugDev.id}"`);

      // Requesting by plughw: must find the plughw: device
      const matchedByPlug = findAvailableMicrophone(plugDev.id);
      assert.strictEqual(matchedByPlug?.id, plugDev.id,
        `findAvailableMicrophone("${plugDev.id}") must match "${plugDev.id}"`);

      console.log(`  PASS: "${hwEquivalent}" and "${plugDev.id}" match interchangeably.`);
    }

    const nameFromHw = getDeviceDisplayName('hw:2,0');
    const nameFromPlug = getDeviceDisplayName('plughw:2,0');
    assert.strictEqual(nameFromHw, nameFromPlug,
      `getDeviceDisplayName must resolve same name for hw:2,0 and plughw:2,0: "${nameFromHw}" vs "${nameFromPlug}"`);
    console.log(`  PASS: getDeviceDisplayName resolves consistently: "${nameFromHw}".`);
  } catch (err) {
    console.error('  FAIL Test 3:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 4: AudioCapture Input Demuxer Arguments Construction
  // ---------------------------------------------------------------------------
  console.log('\n[Test 4] Testing AudioCapture resolveDriverAndArgs input argument structure...');
  try {
    // 4.1: Raw hw: passed as device must be normalized to plughw:
    const captureHw = new AudioCapture({ device: 'hw:2,0', driver: 'alsa', channels: 1, sampleRate: 24000 });
    const resolvedHw = captureHw.resolveDriverAndArgs();
    assert.strictEqual(resolvedHw.device, 'hw:2,0');
    assert(resolvedHw.inputArgs.includes('plughw:2,0'), `Input arguments must map hw:2,0 to plughw:2,0, got: ${resolvedHw.inputArgs.join(' ')}`);

    // 4.2: Demuxer options -channels and -sample_rate must appear BEFORE -i
    const idxChannels = resolvedHw.inputArgs.indexOf('-channels');
    const idxSampleRate = resolvedHw.inputArgs.indexOf('-sample_rate');
    const idxInput = resolvedHw.inputArgs.indexOf('-i');

    assert(idxChannels !== -1 && idxChannels < idxInput,
      `-channels option must appear before -i (got idxChannels=${idxChannels}, idxInput=${idxInput})`);
    assert(idxSampleRate !== -1 && idxSampleRate < idxInput,
      `-sample_rate option must appear before -i (got idxSampleRate=${idxSampleRate}, idxInput=${idxInput})`);
    assert.strictEqual(resolvedHw.inputArgs[idxChannels + 1], '1', 'Input channels must be 1');
    assert.strictEqual(resolvedHw.inputArgs[idxSampleRate + 1], '24000', 'Input sample rate must be 24000');

    console.log(`  PASS: FFmpeg input arguments correctly configured before -i: "${resolvedHw.inputArgs.join(' ')}"`);
  } catch (err) {
    console.error('  FAIL Test 4:', err.message);
    failures++;
  }

  // ---------------------------------------------------------------------------
  // Test 5: Live Capture on USB Microphone (No Channel Error / No Unwanted Switch)
  // ---------------------------------------------------------------------------
  console.log('\n[Test 5] Testing live capture on USB microphone with plughw:2,0...');
  try {
    const devices = scanAudioDevices();
    const usbMic = devices.find(d => d.isUsb);
    const targetDevId = usbMic ? usbMic.id : 'plughw:2,0';

    const capture = new AudioCapture({
      device: targetDevId,
      driver: 'alsa',
      channels: 1,
      sampleRate: 24000,
      searchIntervalMs: 1000
    });

    let unexpectedSwitch = false;
    let channelError = false;
    let chunksReceived = 0;

    capture.on('device_connected', (dev) => {
      // If switched away from target to a completely different device like card 0
      const normTarget = targetDevId.replace('plughw:', 'hw:');
      const normConnected = dev.device.replace('plughw:', 'hw:');
      if (normTarget !== normConnected && dev.device !== targetDevId) {
        unexpectedSwitch = true;
        console.error(`  FAIL: Unexpected device switch detected to "${dev.name}" (${dev.device})!`);
      }
    });

    capture.on('error', (err) => {
      if (err.error && err.error.includes('cannot set channel count')) {
        channelError = true;
      }
    });

    capture.on('data', () => {
      chunksReceived++;
    });

    capture.start();

    // Wait 2.5 seconds
    await new Promise(r => setTimeout(r, 2500));
    capture.stop();

    assert(!channelError, 'ALSA must not reject channel count when using plughw:');
    assert(!unexpectedSwitch, 'App must not switch away from selected USB microphone to Card 0');

    if (usbMic) {
      assert(chunksReceived > 0, `Must receive live audio chunks from USB mic, received: ${chunksReceived}`);
      console.log(`  PASS: Successfully captured ${chunksReceived} clean audio chunks from USB microphone (${targetDevId}) without crash or device switch!`);
    } else {
      console.log('  INFO: USB mic capture tested in environment without physical card error.');
    }
  } catch (err) {
    console.error('  FAIL Test 5:', err.message);
    failures++;
  }

  console.log('\n======================================================');
  if (failures === 0) {
    console.log('  🎉 ALL USB MICROPHONE PATCH TESTS PASSED (5/5)!');
    console.log('======================================================\n');
  } else {
    console.error(`  ❌ ${failures} TEST(S) FAILED!`);
    console.log('======================================================\n');
  }

  process.exit(failures === 0 ? 0 : 1);
}

runTests().catch(err => {
  console.error('[Fatal Error]:', err);
  process.exit(1);
});
