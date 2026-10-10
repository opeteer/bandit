/**
 * Automated Verification for Continuous Microphone Search Engine
 * Simulates a scenario where a missing/invalid device is initially configured,
 * and verifies that Bandit continuously searches for and auto-connects to a real mic.
 */

const AudioCapture = require('../src/audioCapture');

async function testContinuousSearch() {
  console.log('--- TESTING CONTINUOUS MICROPHONE SEARCH & RECOVERY ---');

  // Start with a non-existent device to force search mode
  const capture = new AudioCapture({
    device: 'hw:99,99', // Non-existent hardware device
    driver: 'alsa',
    autoSearchMic: true,
    searchIntervalMs: 1000 // Fast 1s polling for test
  });

  let searchTriggered = false;
  let deviceFound = false;
  let audioChunksCaptured = 0;

  capture.on('status', (st) => {
    if (st.isSearching) {
      searchTriggered = true;
      console.log(`[Test] Received searching status (search count: ${st.searchCount})`);
    }
  });

  capture.on('error', (err) => {
    console.log('[Test] Expected initial error caught:', err.error.split('\n')[0]);
  });

  capture.on('device_connected', (dev) => {
    deviceFound = true;
    console.log(`[Test] Physical device auto-connected: ${dev.name} (${dev.device})`);
  });

  capture.on('data', (chunk) => {
    audioChunksCaptured++;
  });

  console.log('[Test] Starting capture with non-existent device (hw:99,99)...');
  capture.start();

  // Wait up to 6 seconds for continuous search to run and discover real mic
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (deviceFound && audioChunksCaptured >= 5) {
      break;
    }
  }

  capture.stop();

  console.log('\n--- VERIFICATION RESULTS ---');
  console.log('Search mode triggered:', searchTriggered ? 'YES ✅' : 'NO ❌');
  console.log('Physical mic auto-detected:', deviceFound ? 'YES ✅' : 'NO ❌');
  console.log('Audio chunks captured after auto-connect:', audioChunksCaptured > 0 ? `${audioChunksCaptured} chunks ✅` : '0 ❌');

  if (searchTriggered && deviceFound && audioChunksCaptured > 0) {
    console.log('\n🎉 CONTINUOUS MIC AUTO-DISCOVERY TEST PASSED!\n');
    process.exit(0);
  } else {
    console.error('\n❌ CONTINUOUS MIC AUTO-DISCOVERY TEST FAILED!\n');
    process.exit(1);
  }
}

testContinuousSearch();
