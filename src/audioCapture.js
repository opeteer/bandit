/**
 * Bandit Audio Capture Engine
 * Spawns and manages low-latency FFmpeg audio ingestion process.
 * Emits raw PCM s16le binary chunks.
 * Continuously searches for physical microphones when none are detected.
 */

const { spawn } = require('child_process');
const EventEmitter = require('events');
const os = require('os');
const { scanAudioDevices, findAvailableMicrophone, getDeviceDisplayName } = require('./deviceScanner');
const { buildAudioFilterChain, getDspPresetsList } = require('./dspFilters');

class AudioCapture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.device = options.device || process.env.AUDIO_DEVICE || 'auto';
    this.driver = options.driver || process.env.AUDIO_DRIVER || 'auto';
    this.deviceName = options.name || options.deviceName || null;
    this.lastConnectedDevice = null;
    this.sampleRate = parseInt(options.sampleRate || process.env.SAMPLE_RATE || '24000', 10);
    this.channels = parseInt(options.channels || process.env.CHANNELS || '1', 10);
    const rawChunkMs = parseInt(options.chunkMs || process.env.CHUNK_MS || '40', 10);
    this.chunkMs = (!isNaN(rawChunkMs) && rawChunkMs >= 10) ? rawChunkMs : 40;
    this.bytesPerSample = 2; // 16-bit PCM = 2 bytes
    this.chunkSizeBytes = Math.max(128, Math.floor((this.sampleRate * this.channels * this.bytesPerSample * this.chunkMs) / 1000));

    // EasyEffects DSP Engine configuration
    this.dspPreset = options.dspPreset || process.env.DSP_PRESET || 'broadcast';
    this.dspOptions = options.dspOptions || {};
    this.activeFilterString = null;
    this.filterProcess = null;

    // Auto-search for microphone when missing
    this.autoSearchMic = process.env.AUTO_SEARCH_MIC !== 'false';
    this.searchIntervalMs = parseInt(options.searchIntervalMs || process.env.MIC_SEARCH_INTERVAL || '3000', 10);
    this.targetDevice = options.device || process.env.AUDIO_DEVICE || 'auto';
    this.isSearching = false;
    this.searchCount = 0;
    this.searchIntervalTimer = null;
    this.attemptedHwFallback = false;

    this.process = null;
    this.isStopping = false;
    this.isRunning = false;
    this.restartTimer = null;
    this.isRestarting = false;
    this.pendingRestartOptions = null;
    this.activeFfmpegProcs = new Set();
    this.isFallingBack = false;
    this.totalBytesCaptured = 0;
    this.startTime = null;
    this.errorLog = [];
    this.buffer = Buffer.alloc(0);

    // Rolling circular PCM ring buffer for STT audio analysis (disabled by default)
    this.enableRollingBuffer = options.enableRollingBuffer !== undefined ? Boolean(options.enableRollingBuffer) : (process.env.ENABLE_AUDIO_ANALYSIS === 'true');
    this.maxRollingBufferSeconds = 30;
    this.maxRollingBytes = Math.floor(this.sampleRate * this.channels * this.bytesPerSample * this.maxRollingBufferSeconds);
    this.recentAudioBuffer = Buffer.alloc(0);
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
      // Normalize raw hw: to plughw: for automated format, rate, and channel adaptation
      let alsaDev = device;
      if (alsaDev.startsWith('hw:')) {
        alsaDev = 'plug' + alsaDev;
      }
      inputArgs.push('-f', 'alsa');
      if (this.channels) {
        inputArgs.push('-channels', String(this.channels));
      }
      if (this.sampleRate) {
        inputArgs.push('-sample_rate', String(this.sampleRate));
      }
      inputArgs.push('-i', alsaDev);
    } else if (driver === 'pulse') {
      inputArgs.push('-f', 'pulse');
      if (this.channels) {
        inputArgs.push('-channels', String(this.channels));
      }
      if (this.sampleRate) {
        inputArgs.push('-sample_rate', String(this.sampleRate));
      }
      inputArgs.push('-i', device || 'default');
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
        this.deviceName = candidate.name;
      }
    }

    const resolved = this.resolveDriverAndArgs();
    this.currentDriver = resolved.driver;
    this.currentDevice = resolved.device;

    if (this.isFallingBack || this.isSearching || this.device === 'test' || resolved.driver === 'lavfi') {
      this.deviceName = 'Synthetic Test Tone Generator';
    } else if (!this.deviceName) {
      this.deviceName = getDeviceDisplayName(this.device);
    }

    // Build initial EasyEffects DSP filter chain
    this.activeFilterString = buildAudioFilterChain(this.dspPreset, this.dspOptions);

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      ...resolved.inputArgs,
      '-ac', String(this.channels),
      '-ar', String(this.sampleRate),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ];

    console.log(`[AudioCapture] Spawning FFmpeg with driver "${resolved.driver}", device "${resolved.device}" (${this.deviceName || 'Microphone'})`);
    console.log(`[AudioCapture] Format: PCM s16le, ${this.sampleRate} Hz, ${this.channels} channel(s)`);

    try {
      this.process = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const p = this.process;
      this.activeFfmpegProcs.add(p);
      p.once('close', () => {
        this.activeFfmpegProcs.delete(p);
      });
    } catch (err) {
      console.error('[AudioCapture] Failed to spawn ffmpeg:', err.message);
      this.handleProcessFailure(err.message);
      return;
    }

    this.isRunning = true;
    this.isStopping = false;
    this.startTime = Date.now();
    this.buffer = Buffer.alloc(0);

    // Initialize in-memory DSP filter pipeline
    this.updateFilterPipeline();

    this.emit('status', {
      state: 'running',
      driver: this.currentDriver,
      device: this.currentDevice,
      name: this.deviceName,
      deviceName: this.deviceName,
      sampleRate: this.sampleRate,
      channels: this.channels,
      dspPreset: this.dspPreset,
      activeFilterString: this.activeFilterString,
      isFallback: this.isFallingBack,
      isSearching: this.isSearching,
      searchCount: this.searchCount
    });

    let hasEmittedConnected = false;

    // Handle stdout (PCM binary stream from hardware ingestion)
    this.process.stdout.on('data', (data) => {
      if (!hasEmittedConnected && !this.isFallingBack && !this.isSearching && resolved.driver !== 'lavfi' && this.lastConnectedDevice !== this.currentDevice) {
        hasEmittedConnected = true;
        this.lastConnectedDevice = this.currentDevice;
        this.emit('device_connected', {
          device: this.currentDevice,
          name: this.deviceName,
          deviceName: this.deviceName,
          driver: this.currentDriver
        });
      }

      // Route through active DSP filter pipeline or direct bypass fallback
      if (this.filterProcess && this.filterProcess.stdin && this.filterProcess.stdin.writable) {
        this.filterProcess.stdin.write(data);
      } else {
        // Direct bypass fallback: ensure audio chunks never drop if filter process is dead
        this.handleProcessedAudioChunk(data);
      }
    });

    // Handle stderr (FFmpeg capture error logs)
    let stderrLog = '';
    this.process.stderr.on('data', (data) => {
      const msg = data.toString();
      stderrLog += msg;
      if (stderrLog.length > 2000) stderrLog = stderrLog.slice(-2000);
      console.error(`[AudioCapture FFmpeg stderr]: ${msg.trim()}`);
    });

    // Handle capture process termination
    this.process.on('close', (code, signal) => {
      this.isRunning = false;
      console.warn(`[AudioCapture] Process exited with code ${code} (signal: ${signal})`);

      if (this.isStopping) {
        this.isStopping = false;
        this.emit('status', { state: 'stopped', isSearching: this.isSearching });
        return;
      }

      // If intentionally stopped or killed via signal, do not treat as crash
      if (signal === 'SIGTERM' || signal === 'SIGINT' || code === 0 || code === null) {
        this.emit('status', { state: 'stopped', isSearching: this.isSearching });
      } else {
        this.handleProcessFailure(stderrLog || `Process exited with code ${code}`);
      }
    });

    this.process.on('error', (err) => {
      if (this.isStopping) return;
      console.error('[AudioCapture] Process error:', err.message);
      this.handleProcessFailure(err.message);
    });
  }

  /**
   * Internal ingestion sink for fully processed/filtered PCM chunks.
   * Buffers rolling audio for analysis and emits standard chunks to subscribers.
   */
  handleProcessedAudioChunk(data) {
    this.totalBytesCaptured += data.length;
    this.buffer = Buffer.concat([this.buffer, data]);

    // Maintain rolling circular ring buffer of last 30 seconds (if enabled)
    if (this.enableRollingBuffer) {
      this.recentAudioBuffer = Buffer.concat([this.recentAudioBuffer, data]);
      if (this.recentAudioBuffer.length > this.maxRollingBytes) {
        this.recentAudioBuffer = this.recentAudioBuffer.subarray(this.recentAudioBuffer.length - this.maxRollingBytes);
      }
    }

    const minChunk = Math.max(128, this.chunkSizeBytes || 1920);
    while (this.buffer.length >= minChunk) {
      const chunk = this.buffer.subarray(0, minChunk);
      this.buffer = this.buffer.subarray(minChunk);
      this.emit('data', chunk);
    }
  }

  /**
   * Dynamically manage in-memory FFmpeg DSP filter pipeline (pipe:0 -> pipe:1).
   * Swaps filters without interrupting physical audio capture.
   */
  updateFilterPipeline() {
    const filterString = buildAudioFilterChain(this.dspPreset, this.dspOptions);
    this.activeFilterString = filterString;

    if (!filterString) {
      // Raw / Bypass mode: no DSP filter process needed
      if (this.filterProcess) {
        const oldFilter = this.filterProcess;
        this.filterProcess = null;
        try {
          oldFilter.kill('SIGTERM');
        } catch {}
      }
      return;
    }

    const filterArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-probesize', '32',
      '-analyzeduration', '0',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:0',
      '-af', filterString,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1'
    ];

    try {
      const newFilterProc = spawn('ffmpeg', filterArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.activeFfmpegProcs.add(newFilterProc);
      newFilterProc.once('close', () => {
        this.activeFfmpegProcs.delete(newFilterProc);
      });

      newFilterProc.stdout.on('data', (data) => {
        this.handleProcessedAudioChunk(data);
      });

      newFilterProc.stdin.on('error', () => {});
      newFilterProc.on('error', (err) => {
        console.error('[AudioCapture DSP] Filter process error:', err.message);
        if (this.filterProcess === newFilterProc) {
          this.filterProcess = null;
          this.emit('dsp_error', { error: err.message, message: 'DSP filter error. Switched to direct bypass.' });
        }
      });
      newFilterProc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.error(`[AudioCapture DSP stderr]: ${msg}`);
      });

      newFilterProc.on('close', (code, signal) => {
        if (!newFilterProc._intentionalClose && this.filterProcess === newFilterProc) {
          console.warn(`[AudioCapture DSP] Filter process terminated unexpectedly (code ${code}, signal ${signal}). Switched to direct bypass.`);
          this.filterProcess = null;
          this.emit('dsp_error', {
            code,
            signal,
            message: 'DSP filter process crashed. Live audio continuing in direct bypass mode.'
          });
        }
      });

      const oldFilter = this.filterProcess;
      this.filterProcess = newFilterProc;
      if (oldFilter) {
        oldFilter._intentionalClose = true;
        try {
          if (oldFilter.stdin && !oldFilter.stdin.destroyed) {
            oldFilter.stdin.destroy();
          }
          oldFilter.kill('SIGTERM');
          setTimeout(() => {
            try {
              if (oldFilter && !oldFilter.killed) oldFilter.kill('SIGKILL');
            } catch {}
          }, 200).unref();
        } catch {}
      }

      console.log(`[AudioCapture] EasyEffects DSP Active [${this.dspPreset}]: -af "${filterString}"`);
    } catch (err) {
      console.error('[AudioCapture] Failed to spawn DSP filter process:', err.message);
    }
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
      const candidate = findAvailableMicrophone(this.targetDevice || this.device);

      if (candidate) {
        console.log(`[AudioCapture] 🎤 Physical microphone detected: "${candidate.name}" (${candidate.id})! Auto-connecting...`);
        this.stopContinuousMicSearch();

        // Switch to detected physical microphone
        this.device = candidate.id;
        this.driver = candidate.driver;
        this.deviceName = candidate.name;
        this.isFallingBack = false;
        this.isSearching = false;
        this.attemptedHwFallback = false;
        this.lastConnectedDevice = candidate.id;

        this.emit('device_connected', {
          device: candidate.id,
          name: candidate.name,
          deviceName: candidate.name,
          driver: candidate.driver
        });

        // Restart capture with real microphone
        this.restart({ device: candidate.id, driver: candidate.driver, name: candidate.name });
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
      this.lastConnectedDevice = null;
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
   * Stop the capture process and filter pipeline.
   */
  stop() {
    this.stopContinuousMicSearch();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.filterProcess) {
      try {
        this.filterProcess.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.filterProcess = null;
    }

    if (this.process) {
      this.isStopping = true;
      try {
        this.process.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.process = null;
    }

    // Safety sweep: ensure any active or orphaned child processes are terminated
    if (this.activeFfmpegProcs && this.activeFfmpegProcs.size > 0) {
      for (const p of this.activeFfmpegProcs) {
        try {
          if (!p.killed) p.kill('SIGTERM');
        } catch {}
      }
      this.activeFfmpegProcs.clear();
    }

    this.isRunning = false;
    this.buffer = Buffer.alloc(0);
    this.emit('status', { state: 'stopped', isSearching: this.isSearching });
  }

  /**
   * Restart capture with current or new options.
   * Ensures previous FFmpeg process completely terminates before re-opening hardware device.
   */
  restart(newOptions = {}) {
    if (this.isRestarting) {
      // Queue latest options to debounce and avoid spawning competing concurrent processes
      this.pendingRestartOptions = { ...(this.pendingRestartOptions || {}), ...newOptions };
      return;
    }

    this.isRestarting = true;
    const oldProc = this.process;
    this.stop();

    if (newOptions.device) {
      this.targetDevice = newOptions.device;
      this.device = newOptions.device;
      this.currentDevice = newOptions.device;
      this.isFallingBack = false;
      this.isSearching = false;
      this.attemptedHwFallback = false;
    }
    if (newOptions.driver) {
      this.driver = newOptions.driver;
      this.currentDriver = newOptions.driver;
    }
    if (newOptions.name || newOptions.deviceName) {
      this.deviceName = newOptions.name || newOptions.deviceName;
    } else if (newOptions.device) {
      this.deviceName = getDeviceDisplayName(newOptions.device);
    }

    let hasLaunched = false;
    let failsafeTimer = null;

    const launchNewProcess = () => {
      if (hasLaunched) return;
      hasLaunched = true;
      if (failsafeTimer) {
        clearTimeout(failsafeTimer);
        failsafeTimer = null;
      }
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      // Give kernel audio drivers 80ms to fully release PCM card handles
      this.restartTimer = setTimeout(() => {
        this.isRestarting = false;
        if (!this.isRunning) {
          this.start();
        }
        // If rapid switches queued during restart, process latest queued configuration
        if (this.pendingRestartOptions) {
          const nextOpts = this.pendingRestartOptions;
          this.pendingRestartOptions = null;
          this.restart(nextOpts);
        }
      }, 80);
    };

    if (oldProc && !oldProc.killed) {
      oldProc.once('close', launchNewProcess);
      failsafeTimer = setTimeout(launchNewProcess, 350);
    } else {
      launchNewProcess();
    }
  }

  /**
   * Dynamically switch or update the EasyEffects DSP preset.
   * Hot-swaps the DSP filter pipeline in real-time without interrupting hardware capture.
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

    if (this.isRunning) {
      this.updateFilterPipeline();
    }
  }

  /**
   * Retrieve a snapshot of the rolling PCM audio buffer for the last N seconds (default 30s).
   * @param {number} seconds
   * @returns {Buffer} Raw PCM s16le audio buffer
   */
  getRecentAudioBuffer(seconds = 30) {
    if (!this.enableRollingBuffer || !this.recentAudioBuffer || this.recentAudioBuffer.length === 0) {
      return Buffer.alloc(0);
    }
    const sec = Math.max(1, Math.min(seconds, this.maxRollingBufferSeconds));
    const reqBytes = Math.floor(this.sampleRate * this.channels * this.bytesPerSample * sec);
    if (this.recentAudioBuffer.length <= reqBytes) {
      return Buffer.from(this.recentAudioBuffer);
    }
    return Buffer.from(this.recentAudioBuffer.subarray(this.recentAudioBuffer.length - reqBytes));
  }

  /**
   * Diagnostic state object.
   */
  getStatus() {
    const bufferedSecs = (this.recentAudioBuffer.length / (this.sampleRate * this.channels * this.bytesPerSample));
    return {
      isRunning: this.isRunning,
      device: this.device || this.currentDevice,
      name: this.deviceName || getDeviceDisplayName(this.device || this.currentDevice),
      deviceName: this.deviceName || getDeviceDisplayName(this.device || this.currentDevice),
      driver: this.driver || this.currentDriver,
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
      hasRecentBuffer: this.recentAudioBuffer.length > 0,
      recentBufferSeconds: Math.round(bufferedSecs * 10) / 10,
      recentErrors: this.errorLog
    };
  }
}

module.exports = AudioCapture;
