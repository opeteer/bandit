/**
 * Bandit Audio Device Scanner
 * Discovers physical and virtual audio input devices on Linux, Windows, and macOS.
 */

const { execSync } = require('child_process');
const os = require('os');

let cachedDevices = null;
let lastScanTime = 0;
const CACHE_TTL_MS = 5000;

/**
 * Scan for audio input devices based on current OS.
 * Uses a 5-second TTL cache to prevent repeated synchronous child process execution from blocking the event loop.
 */
function scanAudioDevices(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedDevices && (now - lastScanTime) < CACHE_TTL_MS) {
    return cachedDevices.map(d => ({ ...d }));
  }

  const platform = os.platform();
  const devices = [];

  // Always include synthetic test generator option
  devices.push({
    id: 'test',
    driver: 'lavfi',
    name: 'Synthetic Test Tone Generator (No Physical Mic Required)',
    description: 'Generates 440Hz sine tone with rhythmic audio pulses for testing',
    isDefault: false
  });

  if (platform === 'linux') {
    // 1. Try ALSA (arecord -l)
    try {
      const arecordOut = execSync('arecord -l 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const lines = arecordOut.split('\n');
      for (const line of lines) {
        // e.g., "card 1: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]"
        const match = line.match(/^card\s+(\d+):\s+([^,]+),\s+device\s+(\d+):\s+(.*)$/);
        if (match) {
          const cardNum = match[1];
          const cardName = match[2].trim();
          const devNum = match[3];
          const devDesc = match[4].trim();
          devices.push({
            id: `hw:${cardNum},${devNum}`,
            driver: 'alsa',
            name: `${cardName} (${devDesc})`,
            description: `ALSA Direct Hardware (card ${cardNum}, device ${devNum})`,
            isDefault: cardNum === '0' || cardNum === '1'
          });
        }
      }
    } catch {
      // arecord might not be installed or no permission
    }

    // 2. Try ffmpeg -sources alsa
    try {
      const ffmpegOut = execSync('ffmpeg -sources alsa 2>&1', { encoding: 'utf8', timeout: 3000 });
      const lines = ffmpegOut.split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([*]?)\s*([a-zA-Z0-9_:-]+)\s+\[([^\]]+)\]/);
        if (match && !['null'].includes(match[2])) {
          const isDef = match[1] === '*';
          const devId = match[2];
          const desc = match[3];
          // avoid duplicate if already found
          if (!devices.some(d => d.id === devId)) {
            devices.push({
              id: devId,
              driver: 'alsa',
              name: desc,
              description: `ALSA Source: ${devId}`,
              isDefault: isDef
            });
          }
        }
      }
    } catch {
      // ffmpeg alsa sources error
    }

    // Always provide 'default' option on Linux
    if (!devices.some(d => d.id === 'default')) {
      devices.splice(1, 0, {
        id: 'default',
        driver: 'alsa',
        name: 'Default System Audio Capture (ALSA / Pulse / PipeWire)',
        description: 'Standard Linux default recording device',
        isDefault: true
      });
    }

    // 3. Try PulseAudio / PipeWire pactl
    try {
      const pactlOut = execSync('pactl list sources short 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
      const lines = pactlOut.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const sourceName = parts[1];
          if (!sourceName.includes('.monitor')) { // skip speaker monitors
            const isEasyEffects = sourceName.toLowerCase().includes('easyeffects') || sourceName.includes('ee_source');
            devices.push({
              id: sourceName,
              driver: 'pulse',
              name: isEasyEffects ? 'EasyEffects Virtual Microphone (Host Processed)' : `PulseAudio: ${sourceName}`,
              description: isEasyEffects ? 'PipeWire EasyEffects pre-processed audio stream' : 'PulseAudio / PipeWire capture source',
              isDefault: false,
              isEasyEffects
            });
          }
        }
      }
    } catch {
      // pactl not available
    }

  } else if (platform === 'win32') {
    // Windows DirectShow enumeration
    try {
      const ffmpegOut = execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', { encoding: 'utf8', timeout: 5000 });
      const lines = ffmpegOut.split('\n');
      let inAudioSection = false;
      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) {
          inAudioSection = true;
          continue;
        }
        if (line.includes('DirectShow video devices')) {
          inAudioSection = false;
        }
        if (inAudioSection) {
          const match = line.match(/"([^"]+)"/);
          if (match && !line.includes('Alternative name')) {
            const devName = match[1];
            devices.push({
              id: `audio="${devName}"`,
              driver: 'dshow',
              name: devName,
              description: `DirectShow Audio Device: ${devName}`,
              isDefault: devices.length === 1 // first one default
            });
          }
        }
      }
    } catch {
      // dshow query fails or dummy error (exit code is often non-zero on dummy query, regex parse still works)
    }

    if (devices.length === 1) { // only test tone present
      devices.push({
        id: 'audio="default"',
        driver: 'dshow',
        name: 'Default Windows Microphone',
        description: 'DirectShow default audio input device',
        isDefault: true
      });
    }

  } else if (platform === 'darwin') {
    // macOS AVFoundation enumeration
    try {
      const ffmpegOut = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1', { encoding: 'utf8', timeout: 5000 });
      const lines = ffmpegOut.split('\n');
      let inAudioSection = false;
      for (const line of lines) {
        if (line.includes('AVFoundation audio devices')) {
          inAudioSection = true;
          continue;
        }
        if (inAudioSection) {
          const match = line.match(/\[(\d+)\]\s+(.*)$/);
          if (match) {
            const index = match[1];
            const name = match[2].trim();
            devices.push({
              id: `:${index}`,
              driver: 'avfoundation',
              name: name,
              description: `AVFoundation Audio Device [${index}]: ${name}`,
              isDefault: index === '0'
            });
          }
        }
      }
    } catch {
      // avfoundation query
    }

    if (devices.length === 1) {
      devices.push({
        id: ':default',
        driver: 'avfoundation',
        name: 'Default macOS Microphone',
        description: 'AVFoundation default audio input device',
        isDefault: true
      });
    }
  }

  cachedDevices = devices;
  lastScanTime = now;
  return devices;
}

/**
 * Find the first available physical microphone.
 * Prioritizes actual hardware devices over generic or monitor devices.
 */
function findAvailableMicrophone(preferredDevice = null) {
  const devices = scanAudioDevices();
  const physical = devices.filter(d => d.id !== 'test' && !d.id.includes('.monitor'));

  if (physical.length === 0) {
    return null;
  }

  // If a preferred device was requested and exists
  if (preferredDevice && preferredDevice !== 'auto' && preferredDevice !== 'test') {
    const found = physical.find(d => d.id === preferredDevice || d.id === `audio="${preferredDevice}"`);
    if (found) return found;
  }

  // On Linux, prioritize direct hardware devices (e.g. hw:1,0)
  const hwDevice = physical.find(d => d.id.startsWith('hw:'));
  if (hwDevice) {
    return hwDevice;
  }

  // Otherwise pick the default or first available physical device
  const defaultDevice = physical.find(d => d.isDefault) || physical[0];
  return defaultDevice || null;
}

/**
 * Look up the human-readable device name for a given device ID.
 */
function getDeviceDisplayName(deviceId) {
  if (!deviceId || deviceId === 'auto') return 'Auto-detected Microphone';
  if (deviceId === 'test') return 'Synthetic Test Tone Generator';

  try {
    const devices = scanAudioDevices();
    const matched = devices.find(d => d.id === deviceId || d.id === `audio="${deviceId}"` || (d.id && deviceId.includes(d.id)));
    if (matched && matched.name) {
      return matched.name;
    }
  } catch {
    // fallback
  }

  return `Microphone (${deviceId})`;
}

// If run directly from command line
if (require.main === module) {
  console.log('\n======================================================');
  console.log('  Bandit - Audio Input Device Discovery Utility');
  console.log(`  Operating System: ${os.platform()} (${os.arch()})`);
  console.log('======================================================\n');

  const devs = scanAudioDevices();
  if (devs.length === 0) {
    console.log('No audio devices found.');
  } else {
    console.log(`Found ${devs.length} device option(s):\n`);
    devs.forEach((d, idx) => {
      console.log(`[${idx + 1}] ID: ${d.id}`);
      console.log(`    Name:        ${d.name}`);
      console.log(`    Driver:      ${d.driver}`);
      console.log(`    Description: ${d.description}`);
      console.log(`    Default:     ${d.isDefault ? 'YES' : 'No'}`);
      console.log('------------------------------------------------------');
    });

    const activeMic = findAvailableMicrophone();
    console.log('\nAuto-detected Physical Mic Candidate:');
    if (activeMic) {
      console.log(`-> ${activeMic.name} (${activeMic.id})`);
    } else {
      console.log('-> None detected (application will continuously search)');
    }

    console.log('\nTo configure a device, set AUDIO_DEVICE and AUDIO_DRIVER in your .env file:');
    console.log(`Example: AUDIO_DEVICE=${devs[1]?.id || 'default'}\n`);
  }
}

module.exports = {
  scanAudioDevices,
  findAvailableMicrophone,
  getDeviceDisplayName
};

