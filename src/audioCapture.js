/**
 * Bandit Audio Capture Engine
 * Spawns and manages low-latency FFmpeg audio ingestion process.
 * Emits raw PCM s16le binary chunks.
 * Continuously searches for physical microphones when none are detected.
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const os = require('os');
const { scanAudioDevices, findAvailableMicrophone } = require('./deviceScanner');
const { buildAudioFilterChain, getDspPresetsList } = require('./dspFilters');

class AudioCapture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.device = options.device || process.env.AUDIO_DEVICE || 'auto';
    this.driver = options.driver || process.env.AUDIO_DRIVER || 'auto';
    this.sampleRate = parseInt(options.sampleRate || process.env.SAMPLE_RATE || '24000', 10);
    this.channels = parseInt(options.channels || process.env.CHANNELS || '1', 10);
    this.chunkMs = parseInt(options.chunkMs || process.env.CHUNK_MS || '40', 10);
    this.bytesPerSample = 2; // 16-bit PCM = 2 bytes
    this.chunkSizeBytes = Math.floor((this.sampleRate * this.channels * this.bytesPerSample * this.chunkMs) / 1000);

    // EasyEffects DSP Engine configuration
    this.dspPreset = options.dspPreset || process.env.DSP_PRESET || 'broadcast';
    this.dspOptions = options.dspOptions || {};
    this.activeFilterString = null;

    // Auto-search for microphone when missing
    this.autoSearchMic = process.env.AUTO_SEARCH_MIC !== 'false';
    this.searchIntervalMs = parseInt(process.env.MIC_SEARCH_INTERVAL || '3000', 10);
    this.isSearching = false;
    this.searchCount = 0;
    this.searchIntervalTimer = null;
    this.attemptedHwFallback = false;

    this.process = null;
    this.isRunning = false;
    this.restartTimer = null;
    this.isFallingBack = false;
    this.totalBytesCaptured = 0;
    this.startTime = null;
    this.errorLog = [];
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Determine the audio input driver and arguments based on OS and settings.
   */
  resolveDriverAndArgs() {
    const platform = os.platform();
    let driver = this.driver.toLowerCase();
    let device = this.device;

    // Synthetic fallback tone when no hardware mic is ready
    if (this.isFallingBack || this.isSearching || device === 'test' || driver === 'lavfi') {
      return {
        driver: 'lavfi',
        device: 'sine=frequency=440:sample_rate=' + this.sampleRate + ':beep_factor=4',
        inputArgs: [
          '-f', 'lavfi',
          '-i', `sine=frequency=440:sample_rate=${this.sampleRate}:beep_factor=4`
        ]
      };
    }

    if (driver === 'auto') {
      if (platform === 'linux') {
        driver = 'alsa';
      } else if (platform === 'win32') {
        driver = 'dshow';
      } else if (platform === 'darwin') {
        driver = 'avfoundation';
      } else {
        driver = 'alsa';
      }
    }

    // On Linux, if device is auto, pick best detected mic or default
    if (platform === 'linux' && driver === 'alsa' && (!device || device === 'auto')) {
      const detected = findAvailableMicrophone();
      device = detected ? detected.id : 'default';
    }

    const inputArgs = [];

    if (driver === 'alsa') {
      if (!device || device === 'auto') device = 'default';
      inputArgs.push('-f', 'alsa', '-i', device);
    } else if (driver === 'pulse') {
      inputArgs.push('-f', 'pulse', '-i', device || 'default');
    } else if (driver === 'dshow') {
      let dshowDev = device;
      if (!dshowDev.startsWith('audio=')) {
        dshowDev = `audio=${dshowDev}`;
      }
      inputArgs.push('-f', 'dshow', '-i', dshowDev);
    } else if (driver === 'avfoundation') {
      let avDev = device;
      if (!avDev.startsWith(':')) {
        avDev = `:${avDev}`;
      }
      inputArgs.push('-f', 'avfoundation', '-i', avDev);
    } else {
      inputArgs.push('-f', driver, '-i', device);
    }

    return { driver, device, inputArgs };
  }

  /**
   * Start the FFmpeg audio capture process.
   */
  start() {
    if (this.isRunning) return;

    // Check if initial device exists before spawning if in auto mode
    if ((!this.device || this.device === 'auto') && this.autoSearchMic) {
      const candidate = findAvailableMicrophone();
      if (!candidate) {
        console.warn('[AudioCapture] No physical microphone detected at startup.');
        this.startContinuousMicSearch();
        return;
      } else {
        this.device = candidate.id;
        this.driver = candidate.driver;
      }
    }

    const resolved = this.resolveDriverAndArgs();
    this.currentDriver = resolved.driver;
    this.currentDevice = resolved.device;

    // Apply EasyEffects DSP filter chain if active
    const filterString = buildAudioFilterChain(this.dspPreset, this.dspOptions);
    const filterArgs = [];
    if (filterString && !this.isFallingBack && !this.isSearching && resolved.driver !== 'lavfi') {
      filterArgs.push('-af', filterString);
      this.activeFilterString = filterString;
      console.log(`[AudioCapture] EasyEffects DSP Active [${this.dspPreset}]: -af "${filterString}"`);
    } else {
      this.activeFilterString = null;
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      ...resolved.inputArgs,
      ...filterArgs,
      '-ac', String(this.channels),
      '-ar', String(this.sampleRate),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ];

    console.log(`[AudioCapture] Spawning FFmpeg with driver "${resolved.driver}", device "${resolved.device}"`);
    console.log(`[AudioCapture] Format: PCM s16le, ${this.sampleRate} Hz, ${this.channels} channel(s)`);

    try {
      this.process = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      console.error('[AudioCapture] Failed to spawn ffmpeg:', err.message);
      this.handleProcessFailure(err.message);
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.buffer = Buffer.alloc(0);

    this.emit('status', {
      state: 'running',
      driver: this.currentDriver,
      device: this.currentDevice,
      sampleRate: this.sampleRate,
      channels: this.channels,
      dspPreset: this.dspPreset,
      activeFilterString: this.activeFilterString,
      isFallback: this.isFallingBack,
      isSearching: this.isSearching,
      searchCount: this.searchCount
    });

    // Handle stdout (PCM binary stream)
    this.process.stdout.on('data', (data) => {
      this.totalBytesCaptured += data.length;
      this.buffer = Buffer.concat([this.buffer, data]);

      while (this.buffer.length >= this.chunkSizeBytes) {
        const chunk = this.buffer.subarray(0, this.chunkSizeBytes);
        this.buffer = this.buffer.subarray(this.chunkSizeBytes);
        this.emit('data', chunk);
      }
    });

    // Handle stderr (FFmpeg error logs)
    let stderrLog = '';
    this.process.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrLog += msg;
      if (stderrLog.length > 2000) stderrLog = stderrLog.slice(-2000);
      console.error(`[AudioCapture FFmpeg stderr]: ${msg.trim()}`);
    });

    // Handle process termination
    this.process.on('close', (code) => {
      this.isRunning = false;
      console.warn(`[AudioCapture] Process exited with code ${code}`);

      if (code !== 0 && code !== null) {
        this.handleProcessFailure(stderrLog || `Process exited with code ${code}`);
      } else {
        this.emit('status', { state: 'stopped', isSearching: this.isSearching });
      }
    });

    this.process.on('error', (err) => {
      console.error('[AudioCapture] Process error:', err.message);
      this.handleProcessFailure(err.message);
    });
  }

  /**
   * Continuous background microphone scanner.
   * Periodically searches for plugged-in or available physical microphone devices.
   */
  startContinuousMicSearch() {
    if (this.searchIntervalTimer) return;

    this.isSearching = true;
    this.isFallingBack = true;
    console.log(`[AudioCapture] 🔍 No mic device available. Continuously searching for physical microphone every ${this.searchIntervalMs / 1000}s...`);

    // Ensure fallback tone is running so clients receive stream and status
    if (!this.isRunning) {
      this.start();
    }

    this.emit('status', {
      state: 'searching',
      isSearching: true,
      isFallback: true,
      message: 'Searching for microphone device on host PC...',
      searchCount: this.searchCount
    });

    this.searchIntervalTimer = setInterval(() => {
      this.searchCount++;
      const candidate = findAvailableMicrophone();

      if (candidate) {
        console.log(`[AudioCapture] 🎤 Physical microphone detected: "${candidate.name}" (${candidate.id})! Auto-connecting...`);
        this.stopContinuousMicSearch();

        // Switch to detected physical microphone
        this.device = candidate.id;
        this.driver = candidate.driver;
        this.isFallingBack = false;
        this.isSearching = false;
        this.attemptedHwFallback = false;

        this.emit('device_connected', {
          device: candidate.id,
          name: candidate.name,
          driver: candidate.driver
        });

        // Restart capture with real microphone
        this.restart({ device: candidate.id, driver: candidate.driver });
      } else {
        // Still no device found
        this.emit('status', {
          state: 'searching',
          isSearching: true,
          isFallback: true,
          message: `Searching for microphone... (probe #${this.searchCount})`,
          searchCount: this.searchCount
        });
      }
    }, this.searchIntervalMs);
  }

  /**
   * Stop the background search timer.
   */
  stopContinuousMicSearch() {
    if (this.searchIntervalTimer) {
      clearInterval(this.searchIntervalTimer);
      this.searchIntervalTimer = null;
    }
  }

  /**
   * Handle unexpected process crash or failure.
   */
  handleProcessFailure(errorDetails) {
    this.isRunning = false;
    this.errorLog.push({ timestamp: new Date().toISOString(), error: errorDetails });
    if (this.errorLog.length > 10) this.errorLog.shift();

    this.emit('error', {
      error: errorDetails,
      driver: this.currentDriver,
      device: this.currentDevice
    });

    // If 'default' failed on Linux ALSA, try scanning for hardware 'hw:X,Y' first
    if (os.platform() === 'linux' && this.device === 'default' && !this.attemptedHwFallback) {
      this.attemptedHwFallback = true;
      try {
        const hwDev = findAvailableMicrophone();
        if (hwDev && hwDev.id !== 'default') {
          console.warn(`[AudioCapture] 'default' device failed. Retrying with discovered hardware device '${hwDev.id}'...`);
          this.device = hwDev.id;
          this.driver = hwDev.driver;
          this.scheduleRestart(500);
          return;
        }
      } catch {
        // ignore
      }
    }

    // If autoSearchMic is enabled and we are not in deliberate test mode, initiate continuous search!
    if (this.autoSearchMic && this.device !== 'test') {
      console.warn('[AudioCapture] Audio capture failed. Initiating continuous search for microphone device...');
      this.startContinuousMicSearch();
      return;
    }

    // Otherwise standard retry
    if (!this.isFallingBack && this.device !== 'test') {
      this.isFallingBack = true;
      this.scheduleRestart(1000);
    } else {
      this.scheduleRestart(3000);
    }
  }

  scheduleRestart(delayMs) {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (!this.isRunning) {
        this.start();
      }
    }, delayMs);
  }

  /**
   * Stop the capture process.
   */
  stop() {
    this.stopContinuousMicSearch();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.process = null;
    }
    this.isRunning = false;
    this.buffer = Buffer.alloc(0);
    this.emit('status', { state: 'stopped', isSearching: this.isSearching });
  }

  /**
   * Restart capture with current or new options.
   */
  restart(newOptions = {}) {
    this.stop();
    if (newOptions.device) {
      this.device = newOptions.device;
      this.isFallingBack = false;
      this.isSearching = false;
    }
    if (newOptions.driver) this.driver = newOptions.driver;
    setTimeout(() => this.start(), 200);
  }

  /**
   * Dynamically switch or update the EasyEffects DSP preset.
   */
  setDspPreset(presetId, options = {}) {
    console.log(`[AudioCapture] Switching DSP preset to: "${presetId}"`);
    this.dspPreset = presetId;
    this.dspOptions = options;
    const filterString = buildAudioFilterChain(this.dspPreset, this.dspOptions);
    this.activeFilterString = filterString;

    this.emit('dsp_changed', {
      preset: this.dspPreset,
      filterString: this.activeFilterString,
      presets: getDspPresetsList(this.dspPreset)
    });

    if (this.isRunning && !this.isFallingBack && !this.isSearching) {
      this.restart();
    }
  }

  /**
   * Diagnostic state object.
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      device: this.currentDevice || this.device,
      driver: this.currentDriver || this.driver,
      sampleRate: this.sampleRate,
      channels: this.channels,
      chunkMs: this.chunkMs,
      chunkSizeBytes: this.chunkSizeBytes,
      dspPreset: this.dspPreset,
      activeFilterString: this.activeFilterString,
      dspPresets: getDspPresetsList(this.dspPreset),
      isFallback: this.isFallingBack,
      isSearching: this.isSearching,
      searchCount: this.searchCount,
      autoSearchMic: this.autoSearchMic,
      searchIntervalMs: this.searchIntervalMs,
      uptimeSeconds: this.startTime && this.isRunning ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      totalBytesCaptured: this.totalBytesCaptured,
      recentErrors: this.errorLog
    };
  }
}

module.exports = AudioCapture;
