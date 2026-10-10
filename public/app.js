/**
 * BANDIT - Live Audio Surveillance Client Engine
 * Ultra-low latency Web Audio API streaming & dynamic canvas visualizer.
 */

(function () {
  'use strict';

  // State
  let audioCtx = null;
  let masterGainNode = null;
  let boostGainNode = null;
  let analyserNode = null;
  let isPlaying = false;
  let isMuted = false;
  let nextPlayTime = 0;

  let ws = null;
  let wsReconnectTimer = null;
  let reconnectAttempts = 0;
  let pingInterval = null;

  let visualizerMode = 'waveform'; // 'waveform' or 'spectrum'
  let animationFrameId = null;

  // Stream format (defaults updated on WS 'init' message)
  let streamConfig = {
    sampleRate: 24000,
    channels: 1,
    format: 'pcm_s16le',
    chunkMs: 40
  };

  // Telemetry metrics
  let totalBytesReceived = 0;
  let bytesSinceLastSecond = 0;
  let lastThroughputUpdate = performance.now();
  let sessionStartTime = null;
  let currentLatencyMs = null;
  let vuPeakHold = 0;
  let vuPeakDecay = 0.96;

  // DOM Elements
  const canvas = document.getElementById('visualizerCanvas');
  const canvasCtx = canvas.getContext('2d');
  const canvasOverlay = document.getElementById('canvasOverlay');
  const btnStartListening = document.getElementById('btnStartListening');
  const btnTogglePlay = document.getElementById('btnTogglePlay');
  const btnToggleMute = document.getElementById('btnToggleMute');
  const btnReconnect = document.getElementById('btnReconnect');
  const playIcon = document.getElementById('playIcon');
  const playText = document.getElementById('playText');
  const muteIcon = document.getElementById('muteIcon');
  const muteText = document.getElementById('muteText');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeValue = document.getElementById('volumeValue');
  const gainSlider = document.getElementById('gainSlider');
  const gainValue = document.getElementById('gainValue');

  const connectionBadge = document.getElementById('connectionBadge');
  const connectionText = document.getElementById('connectionText');
  const securityBadge = document.getElementById('securityBadge');
  const securityText = document.getElementById('securityText');
  const authBtn = document.getElementById('authBtn');
  const streamHealthBadge = document.getElementById('streamHealthBadge');
  const formatBadge = document.getElementById('formatBadge');
  const audioActivityLed = document.getElementById('audioActivityLed');
  const vuMeterFill = document.getElementById('vuMeterFill');
  const vuPeakIndicator = document.getElementById('vuPeakIndicator');
  const vuDbText = document.getElementById('vuDbText');

  const latencyVal = document.getElementById('latencyVal');
  const bufferHealthVal = document.getElementById('bufferHealthVal');
  const dataRateVal = document.getElementById('dataRateVal');
  const totalDataVal = document.getElementById('totalDataVal');
  const listenersVal = document.getElementById('listenersVal');
  const uptimeVal = document.getElementById('uptimeVal');
  const hostSystemInfo = document.getElementById('hostSystemInfo');

  const btnModeWaveform = document.getElementById('btnModeWaveform');
  const btnModeSpectrum = document.getElementById('btnModeSpectrum');

  const deviceSelect = document.getElementById('deviceSelect');
  const btnSwitchDevice = document.getElementById('btnSwitchDevice');
  const deviceNote = document.getElementById('deviceNote');

  // EasyEffects DSP Elements
  const activeDspBadge = document.getElementById('activeDspBadge');
  const btnToggleDspPanel = document.getElementById('btnToggleDspPanel');
  const dspTuningControls = document.getElementById('dspTuningControls');
  const dspPresetDescription = document.getElementById('dspPresetDescription');
  const dspPresetButtons = document.querySelectorAll('.btn-dsp-preset');
  const sliderGateThreshold = document.getElementById('sliderGateThreshold');
  const sliderDenoiseNf = document.getElementById('sliderDenoiseNf');
  const sliderVoiceBoost = document.getElementById('sliderVoiceBoost');
  const dspGateVal = document.getElementById('dspGateVal');
  const dspDenoiseVal = document.getElementById('dspDenoiseVal');
  const dspBoostVal = document.getElementById('dspBoostVal');
  const featHighPass = document.getElementById('featHighPass');
  const featDenoise = document.getElementById('featDenoise');
  const featGate = document.getElementById('featGate');
  const featEq = document.getElementById('featEq');
  const featComp = document.getElementById('featComp');
  const featLimiter = document.getElementById('featLimiter');
  let currentDspPreset = 'broadcast';
  let dspUpdateTimer = null;

  // Auth Modal Elements
  const authModal = document.getElementById('authModal');
  const tokenInput = document.getElementById('tokenInput');
  const btnSaveToken = document.getElementById('btnSaveToken');
  const btnCancelModal = document.getElementById('btnCancelModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const authErrorMessage = document.getElementById('authErrorMessage');

  // Storage
  const STORAGE_KEY_TOKEN = 'bandit_auth_token';

  // 48-Hour Recording Vault Elements
  const recLiveBadge = document.getElementById('recLiveBadge');
  const recLiveText = document.getElementById('recLiveText');
  const btnRefreshRecordings = document.getElementById('btnRefreshRecordings');
  const btnToggleRecording = document.getElementById('btnToggleRecording');
  const recCurrentBanner = document.getElementById('recCurrentBanner');
  const recActiveIndicator = document.getElementById('recActiveIndicator');
  const currentSegmentName = document.getElementById('currentSegmentName');
  const recPausedNotice = document.getElementById('recPausedNotice');
  const btnResumeRecNotice = document.getElementById('btnResumeRecNotice');
  const recProgressFill = document.getElementById('recProgressFill');
  const recElapsedTime = document.getElementById('recElapsedTime');
  const totalRecFiles = document.getElementById('totalRecFiles');
  const totalRecSize = document.getElementById('totalRecSize');
  const recRetentionPeriod = document.getElementById('recRetentionPeriod');
  const vaultAudioPlayer = document.getElementById('vaultAudioPlayer');
  const vaultPlayerTitle = document.getElementById('vaultPlayerTitle');
  const recordingsTableBody = document.getElementById('recordingsTableBody');

  let activeSegmentState = null;
  let isRecordingActive = true;

  // ---------------------------------------------------------------------------
  // Web Audio Context Initialization
  // ---------------------------------------------------------------------------

  function initAudioContext() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass({
      sampleRate: streamConfig.sampleRate,
      latencyHint: 'interactive'
    });

    // Create gain & analyser nodes
    masterGainNode = audioCtx.createGain();
    masterGainNode.gain.setValueAtTime(parseFloat(volumeSlider.value), audioCtx.currentTime);

    boostGainNode = audioCtx.createGain();
    boostGainNode.gain.setValueAtTime(parseFloat(gainSlider.value), audioCtx.currentTime);

    analyserNode = audioCtx.createGain().context.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.75;

    // Connect audio pipeline: boostGain -> masterGain -> analyser -> destination
    boostGainNode.connect(masterGainNode);
    masterGainNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    nextPlayTime = 0;
    isPlaying = true;
    updatePlayerControlsUI();
    canvasOverlay.classList.add('hidden');
    startVisualizerLoop();
  }

  // ---------------------------------------------------------------------------
  // Low-Latency PCM Audio Playback Queue
  // ---------------------------------------------------------------------------

  function playPcmChunk(arrayBuffer) {
    if (!audioCtx || audioCtx.state !== 'running' || !isPlaying) return;

    // Convert Int16 PCM to Float32 [-1.0, 1.0]
    const int16Array = new Int16Array(arrayBuffer);
    const numSamples = int16Array.length;
    if (numSamples === 0) return;

    const audioBuffer = audioCtx.createBuffer(1, numSamples, streamConfig.sampleRate);
    const channelData = audioBuffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      channelData[i] = int16Array[i] / 32768.0;
    }

    const now = audioCtx.currentTime;

    // Jitter buffer & drift compensation:
    // If nextPlayTime is behind or too far ahead, align to now + 25ms lead-in
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.025;
    } else if (nextPlayTime > now + 0.150) {
      // Latency drift detected (> 150ms buffer). Reset to prevent lag buildup!
      nextPlayTime = now + 0.030;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(boostGainNode);
    source.start(nextPlayTime);

    // Track stream buffer health
    const currentBufferAhead = Math.max(0, Math.round((nextPlayTime - now) * 1000));
    bufferHealthVal.textContent = `${currentBufferAhead} ms`;

    nextPlayTime += audioBuffer.duration;
  }

  // ---------------------------------------------------------------------------
  // Canvas Visualizer & VU Meter
  // ---------------------------------------------------------------------------

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvasCtx.scale(dpr, dpr);
  }

  window.addEventListener('resize', resizeCanvas);

  function startVisualizerLoop() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    const timeBuffer = new Uint8Array(analyserNode ? analyserNode.fftSize : 2048);
    const freqBuffer = new Uint8Array(analyserNode ? analyserNode.frequencyBinCount : 1024);

    function render() {
      animationFrameId = requestAnimationFrame(render);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      // Clear background
      canvasCtx.fillStyle = '#06090f';
      canvasCtx.fillRect(0, 0, width, height);

      // Draw subtle grid lines
      canvasCtx.strokeStyle = 'rgba(36, 48, 72, 0.4)';
      canvasCtx.lineWidth = 1;
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, height / 2);
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();

      if (!analyserNode || !isPlaying) {
        // Idle flat line
        canvasCtx.strokeStyle = '#243048';
        canvasCtx.beginPath();
        canvasCtx.moveTo(0, height / 2);
        canvasCtx.lineTo(width, height / 2);
        canvasCtx.stroke();
        updateVuMeter(0);
        return;
      }

      if (visualizerMode === 'waveform') {
        // Oscilloscope waveform rendering
        analyserNode.getByteTimeDomainData(timeBuffer);

        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = '#00ff88';
        canvasCtx.shadowBlur = 10;
        canvasCtx.shadowColor = '#00ff88';
        canvasCtx.beginPath();

        const sliceWidth = width / timeBuffer.length;
        let x = 0;
        let sumSquares = 0;

        for (let i = 0; i < timeBuffer.length; i++) {
          const v = timeBuffer[i] / 128.0;
          const y = (v * height) / 2;

          const norm = (timeBuffer[i] - 128) / 128;
          sumSquares += norm * norm;

          if (i === 0) {
            canvasCtx.moveTo(x, y);
          } else {
            canvasCtx.lineTo(x, y);
          }
          x += sliceWidth;
        }

        canvasCtx.stroke();
        canvasCtx.shadowBlur = 0; // reset glow

        // Calculate RMS for VU meter
        const rms = Math.sqrt(sumSquares / timeBuffer.length);
        updateVuMeter(rms);

      } else {
        // Frequency spectrum bars rendering
        analyserNode.getByteFrequencyData(freqBuffer);

        const barCount = 64;
        const barWidth = (width / barCount) - 2;
        const step = Math.floor(freqBuffer.length / barCount);

        let sumSquares = 0;

        for (let i = 0; i < barCount; i++) {
          const value = freqBuffer[i * step] || 0;
          const barHeight = (value / 255.0) * height * 0.9;
          const x = i * (barWidth + 2);
          const y = height - barHeight;

          const norm = value / 255.0;
          sumSquares += norm * norm;

          const gradient = canvasCtx.createLinearGradient(0, y, 0, height);
          gradient.addColorStop(0, '#00d4ff');
          gradient.addColorStop(0.7, '#00ff88');
          gradient.addColorStop(1, '#1a2234');

          canvasCtx.fillStyle = gradient;
          canvasCtx.fillRect(x, y, barWidth, barHeight);
        }

        const rms = Math.sqrt(sumSquares / barCount);
        updateVuMeter(rms);
      }
    }

    render();
  }

  function updateVuMeter(rms) {
    // Convert normalized RMS to dB (-60dB to 0dB)
    let db = -100;
    if (rms > 0.0001) {
      db = 20 * Math.log10(rms);
    }

    // Map -60dB to 0dB -> 0% to 100%
    let percent = Math.min(100, Math.max(0, ((db + 60) / 60) * 100));

    // Smooth peak hold
    if (percent > vuPeakHold) {
      vuPeakHold = percent;
    } else {
      vuPeakHold *= vuPeakDecay;
    }

    vuMeterFill.style.width = `${percent.toFixed(1)}%`;
    vuPeakIndicator.style.left = `${vuPeakHold.toFixed(1)}%`;

    if (db > -60) {
      vuDbText.textContent = `${db.toFixed(1)} dB`;
    } else {
      vuDbText.textContent = '-∞ dB';
    }

    // Sound Activity Indicator LED
    if (percent > 15) {
      audioActivityLed.classList.add('active');
    } else {
      audioActivityLed.classList.remove('active');
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket Manager
  // ---------------------------------------------------------------------------

  function getStoredToken() {
    return localStorage.getItem(STORAGE_KEY_TOKEN) || '';
  }

  function setStoredToken(t) {
    if (t) {
      localStorage.setItem(STORAGE_KEY_TOKEN, t.trim());
    } else {
      localStorage.removeItem(STORAGE_KEY_TOKEN);
    }
  }

  function connectWebSocket() {
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }

    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }

    updateConnectionUI('connecting', 'CONNECTING...');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const token = getStoredToken();
    let wsUrl = `${protocol}//${host}/stream`;
    if (token) {
      wsUrl += `?token=${encodeURIComponent(token)}`;
    }

    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[WebSocket] Connected');
      reconnectAttempts = 0;
      updateConnectionUI('connected', 'CONNECTED');
      streamHealthBadge.textContent = 'STREAMING';
      streamHealthBadge.className = 'badge badge-info';

      if (!sessionStartTime) {
        sessionStartTime = Date.now();
      }

      // Start Latency Ping Interval
      startPingTracker();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleControlMessage(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        // Audio chunk
        totalBytesReceived += event.data.byteLength;
        bytesSinceLastSecond += event.data.byteLength;
        playPcmChunk(event.data);
      }
    };

    ws.onclose = (event) => {
      console.warn(`[WebSocket] Closed: code=${event.code}, reason=${event.reason}`);
      stopPingTracker();

      if (event.code === 4401 || event.code === 4001) {
        // Authentication failure
        updateConnectionUI('disconnected', 'AUTH FAILED');
        securityBadge.className = 'badge status-badge';
        securityText.textContent = 'INVALID TOKEN';
        openAuthModal('Access token was rejected by host. Please enter the correct token.');
        return;
      }

      updateConnectionUI('disconnected', 'DISCONNECTED');
      streamHealthBadge.textContent = 'RETRYING';
      streamHealthBadge.className = 'badge';

      // Exponential backoff reconnect
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 8000);
      wsReconnectTimer = setTimeout(connectWebSocket, delay);
    };

    ws.onerror = (err) => {
      console.error('[WebSocket] Error occurred:', err);
    };
  }

  function handleControlMessage(jsonStr) {
    try {
      const msg = JSON.parse(jsonStr);

      if (msg.type === 'init') {
        streamConfig.sampleRate = msg.sampleRate;
        streamConfig.channels = msg.channels;
        streamConfig.chunkMs = msg.chunkMs;
        formatBadge.textContent = `PCM ${msg.sampleRate / 1000}kHz ${msg.channels === 1 ? 'Mono' : 'Stereo'}`;
        if (msg.listeners) listenersVal.textContent = msg.listeners;
        if (msg.isSearching) {
          streamHealthBadge.textContent = 'SEARCHING FOR MIC...';
          streamHealthBadge.className = 'badge status-badge connecting';
          deviceNote.textContent = 'Scanning host PC for microphone...';
        } else {
          deviceNote.textContent = `Current: ${msg.device} (${msg.driver})`;
        }
        if (msg.dspPreset) {
          updateDspUI(msg.dspPreset);
        }
        if (msg.recording) {
          updateRecordingStats(msg.recording);
          loadRecordings();
        }
      } else if (msg.type === 'pong') {
        const rtt = Math.round(performance.now() - msg.clientTime);
        currentLatencyMs = rtt;
        latencyVal.textContent = `${rtt} ms`;
      } else if (msg.type === 'auth_required') {
        openAuthModal('Authentication required by host.');
      } else if (msg.type === 'auth_error') {
        openAuthModal(msg.message || 'Authentication error.');
      } else if (msg.type === 'dsp_changed') {
        if (msg.preset) {
          updateDspUI(msg.preset);
        }
      } else if (msg.type === 'capture_status') {
        if (msg.dspPreset) {
          updateDspUI(msg.dspPreset);
        }
        if (msg.isSearching) {
          streamHealthBadge.textContent = 'SEARCHING FOR MIC...';
          streamHealthBadge.className = 'badge status-badge connecting';
          deviceNote.textContent = msg.message || 'Searching host PC for microphone...';
        } else if (msg.isFallback) {
          deviceNote.textContent = `Current: Synthetic Test Tone (Hardware mic fallback)`;
        } else {
          streamHealthBadge.textContent = 'STREAMING';
          streamHealthBadge.className = 'badge badge-info';
          if (msg.device) {
            deviceNote.textContent = `Current: ${msg.device} (${msg.driver})`;
          }
        }
      } else if (msg.type === 'device_connected') {
        streamHealthBadge.textContent = 'STREAMING';
        streamHealthBadge.className = 'badge badge-info';
        deviceNote.textContent = `Connected: ${msg.name} (${msg.device})`;
        loadDevices();
      } else if (msg.type === 'recording_segment_started') {
        activeSegmentState = {
          filename: msg.filename,
          startTime: msg.startTime || Date.now(),
          elapsedSeconds: 0,
          maxSeconds: msg.maxDurationSeconds || 3600
        };
        updateSegmentUI();
        loadRecordings();
      } else if (msg.type === 'recording_segment_saved') {
        loadRecordings();
      } else if (msg.type === 'recordings_purged') {
        console.log(`[Vault] ${msg.count} expired recordings automatically purged (>48h)`);
        loadRecordings();
      } else if (msg.type === 'recording_status_changed') {
        updateRecordingStats(msg.stats);
        loadRecordings();
      } else if (msg.type === 'recordings_list') {
        if (msg.data) {
          renderRecordings(msg.data);
        }
      }
    } catch (e) {
      console.error('[ControlMessage] Parse error:', e);
    }
  }

  function startPingTracker() {
    stopPingTracker();
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ping',
          clientTime: performance.now()
        }));
      }
    }, 2000);
  }

  function stopPingTracker() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  function updateConnectionUI(state, text) {
    connectionBadge.className = `badge status-badge ${state}`;
    connectionText.textContent = text;
  }

  // ---------------------------------------------------------------------------
  // Telemetry Periodic Counter (Throughput & Uptime)
  // ---------------------------------------------------------------------------

  setInterval(() => {
    const now = performance.now();
    const elapsedSec = (now - lastThroughputUpdate) / 1000;
    if (elapsedSec >= 1) {
      const kbps = (bytesSinceLastSecond / 1024) / elapsedSec;
      dataRateVal.textContent = `${kbps.toFixed(1)} KB/s`;
      bytesSinceLastSecond = 0;
      lastThroughputUpdate = now;
    }

    totalDataVal.textContent = `${(totalBytesReceived / (1024 * 1024)).toFixed(2)} MB`;

    if (sessionStartTime) {
      const seconds = Math.floor((Date.now() - sessionStartTime) / 1000);
      const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      uptimeVal.textContent = `${h}:${m}:${s}`;
    }
  }, 1000);

  // ---------------------------------------------------------------------------
  // Player Controls & Volume Handling
  // ---------------------------------------------------------------------------

  function updatePlayerControlsUI() {
    if (isPlaying) {
      btnTogglePlay.disabled = false;
      playIcon.textContent = '⏸';
      playText.textContent = 'PAUSE';
      btnTogglePlay.classList.add('btn-primary');
      btnTogglePlay.classList.remove('btn-action');
    } else {
      btnTogglePlay.disabled = false;
      playIcon.textContent = '▶';
      playText.textContent = 'RESUME';
      btnTogglePlay.classList.remove('btn-primary');
      btnTogglePlay.classList.add('btn-action');
    }

    if (isMuted) {
      muteIcon.textContent = '🔇';
      muteText.textContent = 'UNMUTE';
    } else {
      muteIcon.textContent = '🔊';
      muteText.textContent = 'MUTE';
    }
  }

  btnStartListening.addEventListener('click', () => {
    initAudioContext();
  });

  btnTogglePlay.addEventListener('click', () => {
    if (!audioCtx) {
      initAudioContext();
      return;
    }
    if (audioCtx.state === 'running' && isPlaying) {
      audioCtx.suspend();
      isPlaying = false;
    } else {
      audioCtx.resume();
      isPlaying = true;
    }
    updatePlayerControlsUI();
  });

  btnToggleMute.addEventListener('click', () => {
    isMuted = !isMuted;
    if (masterGainNode) {
      masterGainNode.gain.setValueAtTime(isMuted ? 0 : parseFloat(volumeSlider.value), audioCtx.currentTime);
    }
    updatePlayerControlsUI();
  });

  btnReconnect.addEventListener('click', () => {
    connectWebSocket();
  });

  volumeSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    volumeValue.textContent = `${Math.round(val * 100)}%`;
    if (!isMuted && masterGainNode && audioCtx) {
      masterGainNode.gain.setValueAtTime(val, audioCtx.currentTime);
    }
  });

  gainSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    gainValue.textContent = `${val.toFixed(1)}x`;
    if (boostGainNode && audioCtx) {
      boostGainNode.gain.setValueAtTime(val, audioCtx.currentTime);
    }
  });

  // Visualizer Mode Switches
  btnModeWaveform.addEventListener('click', () => {
    visualizerMode = 'waveform';
    btnModeWaveform.classList.add('active');
    btnModeSpectrum.classList.remove('active');
  });

  btnModeSpectrum.addEventListener('click', () => {
    visualizerMode = 'spectrum';
    btnModeSpectrum.classList.add('active');
    btnModeWaveform.classList.remove('active');
  });

  // ---------------------------------------------------------------------------
  // EasyEffects DSP Sound Rack Controllers
  // ---------------------------------------------------------------------------

  const DSP_METADATA = {
    raw: {
      name: 'RAW / BYPASS',
      desc: 'Unprocessed bit-for-bit physical microphone audio without any filtering.',
      features: { highPass: false, denoise: false, gate: false, eq: false, comp: false, limiter: false }
    },
    whisper: {
      name: 'WHISPER BOOST',
      desc: 'Ultra-sensitive sound enhancement. Amplifies faint distant whispers and speech frequencies with aggressive AGC, 4x speech expansion, and ear-protection limiting.',
      features: { highPass: true, denoise: true, gate: false, eq: true, comp: true, limiter: true }
    },
    broadcast: {
      name: 'CLEAN BROADCAST',
      desc: 'Studio-quality speech clarity based on EasyEffects broadcast profiles. Noise gate, neural denoiser, vocal presence EQ, de-esser, and smooth radio leveling.',
      features: { highPass: true, denoise: true, gate: true, eq: true, comp: true, limiter: true }
    },
    noise_rejection: {
      name: 'NOISE REJECTION',
      desc: 'Maximum noise suppression for noisy server rooms, street traffic, or loud PC cooling fans. Strict noise gate with heavy spectral filtering.',
      features: { highPass: true, denoise: true, gate: true, eq: true, comp: false, limiter: true }
    }
  };

  function updateDspUI(presetId) {
    currentDspPreset = presetId || 'broadcast';
    const meta = DSP_METADATA[currentDspPreset] || DSP_METADATA.raw;

    // Update active badge and description
    if (activeDspBadge) activeDspBadge.textContent = meta.name;
    if (dspPresetDescription) dspPresetDescription.textContent = meta.desc;

    // Update preset buttons active state
    if (dspPresetButtons) {
      dspPresetButtons.forEach((btn) => {
        if (btn.dataset.preset === currentDspPreset) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    }

    // Update feature pills
    if (featHighPass) featHighPass.classList.toggle('active', meta.features.highPass);
    if (featDenoise) featDenoise.classList.toggle('active', meta.features.denoise);
    if (featGate) featGate.classList.toggle('active', meta.features.gate);
    if (featEq) featEq.classList.toggle('active', meta.features.eq);
    if (featComp) featComp.classList.toggle('active', meta.features.comp);
    if (featLimiter) featLimiter.classList.toggle('active', meta.features.limiter);
  }

  function getTuningOptions() {
    return {
      gateThreshold: parseFloat(sliderGateThreshold ? sliderGateThreshold.value : -34),
      denoiseNf: parseFloat(sliderDenoiseNf ? sliderDenoiseNf.value : -25),
      presenceGain: parseFloat(sliderVoiceBoost ? sliderVoiceBoost.value : 3.0),
      boostGain: parseFloat(sliderVoiceBoost ? sliderVoiceBoost.value : 4.5)
    };
  }

  async function applyDspPreset(presetId, options = null) {
    currentDspPreset = presetId;
    updateDspUI(presetId);
    const opts = options || getTuningOptions();

    // 1. Send via WebSocket if open
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'set_dsp_preset',
        preset: presetId,
        options: opts
      }));
    }

    // 2. Also send via REST API
    const token = getStoredToken();
    try {
      await fetch('/api/dsp/preset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ preset: presetId, options: opts })
      });
    } catch {
      // ignore
    }
  }

  // Preset button click listeners
  if (dspPresetButtons) {
    dspPresetButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const presetId = btn.dataset.preset;
        applyDspPreset(presetId);
      });
    });
  }

  // Tuning controls toggle
  if (btnToggleDspPanel && dspTuningControls) {
    btnToggleDspPanel.addEventListener('click', () => {
      const isHidden = dspTuningControls.classList.toggle('hidden');
      btnToggleDspPanel.textContent = isHidden ? 'Tuning Controls' : 'Hide Controls';
    });
  }

  // Tuning sliders
  function debouncedDspUpdate() {
    if (dspUpdateTimer) clearTimeout(dspUpdateTimer);
    dspUpdateTimer = setTimeout(() => {
      applyDspPreset(currentDspPreset, getTuningOptions());
    }, 250);
  }

  if (sliderGateThreshold) {
    sliderGateThreshold.addEventListener('input', (e) => {
      if (dspGateVal) dspGateVal.textContent = `${e.target.value} dB`;
      debouncedDspUpdate();
    });
  }

  if (sliderDenoiseNf) {
    sliderDenoiseNf.addEventListener('input', (e) => {
      if (dspDenoiseVal) dspDenoiseVal.textContent = `${e.target.value} dB`;
      debouncedDspUpdate();
    });
  }

  if (sliderVoiceBoost) {
    sliderVoiceBoost.addEventListener('input', (e) => {
      if (dspBoostVal) dspBoostVal.textContent = `+${parseFloat(e.target.value).toFixed(1)} dB`;
      debouncedDspUpdate();
    });
  }

  // ---------------------------------------------------------------------------
  // Device Query & Switch
  // ---------------------------------------------------------------------------

  async function loadDevices() {
    const token = getStoredToken();
    try {
      const res = await fetch(`/api/devices?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const data = await res.json();
        deviceSelect.innerHTML = '';
        data.devices.forEach((dev) => {
          const opt = document.createElement('option');
          opt.value = dev.id;
          opt.textContent = `${dev.name} [${dev.driver}]`;
          if (dev.id === data.currentDevice) opt.selected = true;
          deviceSelect.appendChild(opt);
        });
        deviceNote.textContent = `Current: ${data.currentDevice} (${data.currentDriver})`;
      }
    } catch {
      // ignore
    }
  }

  btnSwitchDevice.addEventListener('click', async () => {
    const selected = deviceSelect.value;
    const token = getStoredToken();
    try {
      const res = await fetch('/api/capture/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ device: selected })
      });
      if (res.ok) {
        deviceNote.textContent = `Switched to: ${selected}`;
      } else {
        alert('Failed to switch device. Check authentication or device status.');
      }
    } catch (e) {
      alert('Error switching device: ' + e.message);
    }
  });

  // ---------------------------------------------------------------------------
  // Status Check & Auth Handling
  // ---------------------------------------------------------------------------

  async function checkServerStatus() {
    const token = getStoredToken();
    try {
      const res = await fetch(`/api/status?token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.system) {
          hostSystemInfo.textContent = `Host: ${data.system.platform} (${data.system.arch}) // Node ${data.system.nodeVersion}`;
        }
        if (data.recording) {
          updateRecordingStats(data.recording);
        }
        if (data.authRequired) {
          if (data.isAuthenticated) {
            securityBadge.className = 'badge security-badge secure';
            securityText.textContent = 'SECURE (AUTHENTICATED)';
          } else {
            securityBadge.className = 'badge status-badge';
            securityText.textContent = 'AUTH REQUIRED';
            openAuthModal();
          }
        } else {
          securityBadge.className = 'badge security-badge';
          securityText.textContent = 'OPEN (NO AUTH)';
          authBtn.style.display = 'none';
        }
      }
    } catch (err) {
      console.warn('Status check failed:', err);
    }
  }

  function openAuthModal(errorMsg = '') {
    tokenInput.value = getStoredToken();
    authErrorMessage.textContent = errorMsg;
    authModal.classList.add('open');
    tokenInput.focus();
  }

  function closeAuthModal() {
    authModal.classList.remove('open');
    authErrorMessage.textContent = '';
  }

  authBtn.addEventListener('click', () => openAuthModal());
  btnCloseModal.addEventListener('click', () => closeAuthModal());
  btnCancelModal.addEventListener('click', () => closeAuthModal());

  btnSaveToken.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    setStoredToken(token);
    closeAuthModal();
    checkServerStatus();
    loadDevices();
    loadRecordings();
    connectWebSocket();
  });

  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnSaveToken.click();
    }
  });

  // ---------------------------------------------------------------------------
  // 48-Hour Automatic Recording Vault System
  // ---------------------------------------------------------------------------

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }

  function updateSegmentUI() {
    if (activeSegmentState && isRecordingActive) {
      if (recCurrentBanner) recCurrentBanner.classList.remove('is-paused');
      if (recActiveIndicator) {
        recActiveIndicator.textContent = '● ACTIVE RECORDING SEGMENT:';
        recActiveIndicator.className = 'rec-active-indicator';
      }
      if (currentSegmentName) {
        currentSegmentName.textContent = activeSegmentState.filename;
        currentSegmentName.style.display = 'inline-block';
      }
      if (recPausedNotice) recPausedNotice.classList.add('hidden');
      const elapsed = activeSegmentState.elapsedSeconds || 0;
      const maxSec = activeSegmentState.maxSeconds || 3600;
      const pct = Math.min(100, Math.max(0, (elapsed / maxSec) * 100));

      if (recProgressFill) {
        recProgressFill.style.width = `${pct.toFixed(1)}%`;
      }
      if (recElapsedTime) {
        recElapsedTime.textContent = `${formatDuration(elapsed)} / ${formatDuration(maxSec)}`;
      }
    } else {
      if (recCurrentBanner) recCurrentBanner.classList.add('is-paused');
      if (recActiveIndicator) {
        recActiveIndicator.textContent = '⏸️ AUTO RECORDING:';
        recActiveIndicator.className = 'rec-active-indicator paused';
      }
      if (currentSegmentName) {
        currentSegmentName.textContent = 'PAUSED / TURNED OFF';
        currentSegmentName.style.display = 'inline-block';
      }
      if (recPausedNotice) recPausedNotice.classList.remove('hidden');
      if (recProgressFill) {
        recProgressFill.style.width = '0%';
      }
      if (recElapsedTime) {
        recElapsedTime.textContent = 'Paused (Click Turn ON to resume)';
      }
    }
  }

  function startSegmentTimer() {
    setInterval(() => {
      if (activeSegmentState && isRecordingActive) {
        activeSegmentState.elapsedSeconds = (activeSegmentState.elapsedSeconds || 0) + 1;
        updateSegmentUI();
      }
    }, 1000);
  }

  function updateRecordingStats(stats) {
    if (!stats) return;
    const isEnabled = stats.enabled !== undefined ? Boolean(stats.enabled) : Boolean(stats.isRecording);
    isRecordingActive = isEnabled && Boolean(stats.isRecording);

    if (recLiveBadge) {
      if (isEnabled) {
        recLiveBadge.className = 'badge rec-status-badge active';
        recLiveText.textContent = 'REC LIVE (1H/SEGMENT)';
      } else {
        recLiveBadge.className = 'badge rec-status-badge paused';
        recLiveText.textContent = 'REC OFF (MANUAL PAUSE)';
      }
    }

    if (btnToggleRecording) {
      if (isEnabled) {
        btnToggleRecording.className = 'btn btn-sm btn-rec-toggle active';
        btnToggleRecording.innerHTML = '<span class="toggle-icon">⏹</span> Turn OFF Auto Record';
        btnToggleRecording.title = 'Click to manually turn off / pause automatic recording';
      } else {
        btnToggleRecording.className = 'btn btn-sm btn-rec-toggle paused';
        btnToggleRecording.innerHTML = '<span class="toggle-icon">▶</span> Turn ON Auto Record';
        btnToggleRecording.title = 'Click to manually turn on / resume automatic recording';
      }
    }

    if (stats.retentionHours && recRetentionPeriod) {
      recRetentionPeriod.textContent = `${stats.retentionHours}h`;
    }
    if (stats.totalFiles !== undefined && totalRecFiles) {
      totalRecFiles.textContent = stats.totalFiles;
    }
    if (stats.totalSizeFormatted && totalRecSize) {
      totalRecSize.textContent = stats.totalSizeFormatted;
    }

    if (isEnabled && stats.currentSegment) {
      activeSegmentState = {
        filename: stats.currentSegment.filename,
        startTime: Date.now() - (stats.currentSegment.elapsedSeconds * 1000),
        elapsedSeconds: stats.currentSegment.elapsedSeconds,
        maxSeconds: stats.currentSegment.maxSeconds || 3600
      };
    } else {
      activeSegmentState = null;
    }
    updateSegmentUI();
  }

  async function loadRecordings() {
    const token = getStoredToken();
    try {
      const res = await fetch(`/api/recordings?token=${encodeURIComponent(token)}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        renderRecordings(data);
      }
    } catch (err) {
      console.warn('[Vault] Failed to load recordings:', err);
    }
  }

  function renderRecordings(data) {
    if (!recordingsTableBody) return;
    const recordings = data?.recordings || [];
    const stats = data?.stats;

    if (stats) {
      updateRecordingStats(stats);
    }

    if (recordings.length === 0) {
      recordingsTableBody.innerHTML = `
        <tr class="empty-row">
          <td colspan="6">No recordings stored yet. Host microphone audio will be saved in rolling 1-hour files.</td>
        </tr>
      `;
      return;
    }

    const token = getStoredToken();
    let rowsHtml = '';

    for (const rec of recordings) {
      const isCurrent = rec.isCurrent;
      const statusBadge = isCurrent
        ? '<span class="tag-active-rec">● RECORDING</span>'
        : '<span class="tag-saved">SAVED</span>';

      const downloadUrl = `${rec.downloadUrl}?token=${encodeURIComponent(token)}&download=1`;
      const dateFormatted = new Date(rec.modifiedAt || rec.createdAt).toLocaleString();

      rowsHtml += `
        <tr>
          <td>${statusBadge}</td>
          <td><strong>${escapeHtml(rec.filename)}</strong></td>
          <td>${rec.sizeFormatted || '0 B'}</td>
          <td>${rec.ageHours !== undefined ? rec.ageHours + 'h' : '--'}</td>
          <td>${dateFormatted}</td>
          <td style="text-align: right;">
            <div class="rec-actions">
              <button class="btn-rec btn-play-rec" data-file="${escapeHtml(rec.filename)}">▶ Play</button>
              <a class="btn-rec" href="${downloadUrl}" download="${escapeHtml(rec.filename)}">⬇ Save</a>
              ${!isCurrent ? `<button class="btn-rec btn-del-rec" data-file="${escapeHtml(rec.filename)}">🗑 Del</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }

    recordingsTableBody.innerHTML = rowsHtml;

    // Attach row button events
    recordingsTableBody.querySelectorAll('.btn-play-rec').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.getAttribute('data-file');
        if (file) playRecording(file);
      });
    });

    recordingsTableBody.querySelectorAll('.btn-del-rec').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.getAttribute('data-file');
        if (file) deleteRecording(file);
      });
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function playRecording(filename) {
    const token = getStoredToken();
    const url = `/api/recordings/${encodeURIComponent(filename)}?token=${encodeURIComponent(token)}`;
    if (vaultPlayerTitle) {
      vaultPlayerTitle.textContent = filename;
    }
    if (vaultAudioPlayer) {
      vaultAudioPlayer.src = url;
      vaultAudioPlayer.play().catch(e => console.warn('[Vault] Playback trigger warning:', e));
    }
  }

  async function deleteRecording(filename) {
    if (!confirm(`Delete "${filename}" from 48-hour recording vault?`)) return;
    const token = getStoredToken();
    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        loadRecordings();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Failed to delete recording');
      }
    } catch (e) {
      alert('Delete error: ' + e.message);
    }
  }

  async function toggleRecording(desiredState = null) {
    const token = getStoredToken();
    try {
      const payload = typeof desiredState === 'boolean' ? { enabled: desiredState } : {};
      const res = await fetch('/api/recordings/toggle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        updateRecordingStats(data.stats);
        loadRecordings();
      }
    } catch (e) {
      console.error('[Vault] Error toggling recording:', e);
    }
  }

  if (btnRefreshRecordings) {
    btnRefreshRecordings.addEventListener('click', () => loadRecordings());
  }

  if (btnToggleRecording) {
    btnToggleRecording.addEventListener('click', () => toggleRecording());
  }

  if (btnResumeRecNotice) {
    btnResumeRecNotice.addEventListener('click', () => toggleRecording(true));
  }

  // ---------------------------------------------------------------------------
  // Bootstrapping
  // ---------------------------------------------------------------------------

  resizeCanvas();
  startSegmentTimer();
  checkServerStatus();
  loadDevices();
  loadRecordings();
  connectWebSocket();

})();
