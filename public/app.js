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
  const deviceCompactRow = document.getElementById('deviceCompactRow');

  // Available Microphones Elements & Action Buttons
  const btnOpenMicModal = document.getElementById('btnOpenMicModal');
  const btnRescanMics = document.getElementById('btnRescanMics');
  const btnToggleCompactSelect = document.getElementById('btnToggleCompactSelect');
  const micsListGrid = document.getElementById('micsListGrid');
  const micsCountBadge = document.getElementById('micsCountBadge');

  // Microphone Modal Elements
  const micModal = document.getElementById('micModal');
  const btnCloseMicModal = document.getElementById('btnCloseMicModal');
  const btnCloseMicModalFooter = document.getElementById('btnCloseMicModalFooter');
  const btnModalRescanMics = document.getElementById('btnModalRescanMics');
  const modalMicsListContainer = document.getElementById('modalMicsListContainer');
  const modalCurrentMicName = document.getElementById('modalCurrentMicName');

  // Active Microphone Display & Notifications
  const headerDeviceBadge = document.getElementById('headerDeviceBadge');
  const headerDeviceName = document.getElementById('headerDeviceName');
  const activeMicBanner = document.getElementById('activeMicBanner');
  const activeMicName = document.getElementById('activeMicName');
  const activeMicSubtext = document.getElementById('activeMicSubtext');
  const activeMicStatusBadge = document.getElementById('activeMicStatusBadge');
  const toastContainer = document.getElementById('toastContainer');

  let currentActiveDeviceName = null;
  let cachedDevices = [];
  let currentActiveDeviceId = null;

  function showToast(message, type = 'info') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);
    toastContainer.appendChild(toast);

    // Echo toast notification to screen-reader live region (REC-QA-03)
    announceLiveMessage(message);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 4000);
  }

  function updateConnectedDevice(info) {
    if (!info) return;

    const devId = info.device || info.id || '--';
    const devDriver = info.driver || '--';
    const devName = info.name || info.deviceName || devId;

    if (info.isSearching) {
      if (headerDeviceBadge) headerDeviceBadge.className = 'badge device-badge searching';
      if (headerDeviceName) headerDeviceName.textContent = 'MIC: SEARCHING...';
      if (activeMicBanner) activeMicBanner.className = 'active-mic-banner searching';
      if (activeMicName) activeMicName.textContent = info.message || 'Scanning host PC for microphone...';
      if (activeMicSubtext) activeMicSubtext.textContent = 'Probing physical audio hardware in background...';
      if (activeMicStatusBadge) {
        activeMicStatusBadge.textContent = 'SEARCHING';
        activeMicStatusBadge.className = 'badge badge-warning';
      }
      if (deviceNote) deviceNote.textContent = info.message || 'Scanning host PC for microphone...';
      currentActiveDeviceName = null;
      return;
    }

    if (info.isFallback || devId === 'test' || devDriver === 'lavfi') {
      if (headerDeviceBadge) headerDeviceBadge.className = 'badge device-badge fallback';
      if (headerDeviceName) headerDeviceName.textContent = 'MIC: TEST TONE';
      if (activeMicBanner) activeMicBanner.className = 'active-mic-banner fallback';
      if (activeMicName) activeMicName.textContent = 'Synthetic Test Tone Generator';
      if (activeMicSubtext) activeMicSubtext.textContent = `Mode: Synthetic 440Hz Sine Tone | Driver: ${devDriver}`;
      if (activeMicStatusBadge) {
        activeMicStatusBadge.textContent = 'TEST MODE';
        activeMicStatusBadge.className = 'badge badge-info';
      }
      if (deviceNote) deviceNote.textContent = 'Current: Synthetic Test Tone (Hardware mic fallback)';
      currentActiveDeviceName = 'Synthetic Test Tone Generator';
      return;
    }

    // Real physical microphone connected!
    if (headerDeviceBadge) {
      headerDeviceBadge.className = 'badge device-badge connected';
      headerDeviceBadge.title = `Connected: ${devName} (${devId})`;
    }
    if (headerDeviceName) {
      headerDeviceName.textContent = `MIC: ${devName}`;
    }
    if (activeMicBanner) {
      activeMicBanner.className = 'active-mic-banner';
    }
    if (activeMicName) {
      activeMicName.textContent = devName;
    }
    if (activeMicSubtext) {
      activeMicSubtext.textContent = `Device ID: ${devId} | Driver: ${devDriver}`;
    }
    if (activeMicStatusBadge) {
      activeMicStatusBadge.textContent = 'ONLINE';
      activeMicStatusBadge.className = 'badge badge-success';
    }
    if (deviceNote) {
      deviceNote.textContent = `Connected: ${devName} (${devId})`;
    }
    if (modalCurrentMicName) {
      modalCurrentMicName.textContent = devName;
    }

    // Sync select option if available
    if (deviceSelect && devId && devId !== 'auto') {
      for (let i = 0; i < deviceSelect.options.length; i++) {
        if (deviceSelect.options[i].value === devId) {
          deviceSelect.selectedIndex = i;
          break;
        }
      }
    }

    currentActiveDeviceName = devName;
    currentActiveDeviceId = devId;
    if (typeof updateActiveCardHighlights === 'function') {
      updateActiveCardHighlights(devId);
    }
  }

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
  const deleteConfirmModal = document.getElementById('deleteConfirmModal');
  const btnCloseDeleteModal = document.getElementById('btnCloseDeleteModal');
  const deleteTargetFilename = document.getElementById('deleteTargetFilename');
  const btnCancelDelete = document.getElementById('btnCancelDelete');
  const btnConfirmDelete = document.getElementById('btnConfirmDelete');

  // Top Navigation & Tab Elements
  const navTabs = document.querySelectorAll('.nav-tab');
  const viewLive = document.getElementById('viewLive');
  const viewVault = document.getElementById('viewVault');
  const viewAnalysis = document.getElementById('viewAnalysis');
  const btnQuick30sLive = document.getElementById('btnQuick30sLive');

  // Audio Analysis Elements
  const whisperEngineBadge = document.getElementById('whisperEngineBadge');
  const whisperModelBadge = document.getElementById('whisperModelBadge');
  const btnConfigWhisper = document.getElementById('btnConfigWhisper');
  const btnAnalyzeLive30s = document.getElementById('btnAnalyzeLive30s');
  const bufferInfoText = document.getElementById('bufferInfoText');
  const analysisVaultSelect = document.getElementById('analysisVaultSelect');
  const btnAnalyzeVaultFile = document.getElementById('btnAnalyzeVaultFile');
  const analysisLanguageSelect = document.getElementById('analysisLanguageSelect');
  const analysisKeywordsInput = document.getElementById('analysisKeywordsInput');
  const analysisMaxSpeakers = document.getElementById('analysisMaxSpeakers');
  const analysisProgressBanner = document.getElementById('analysisProgressBanner');
  const analysisProgressTitle = document.getElementById('analysisProgressTitle');
  const analysisProgressSubtext = document.getElementById('analysisProgressSubtext');
  const analysisResultsWorkspace = document.getElementById('analysisResultsWorkspace');

  // Results Telemetry Elements
  const resLanguage = document.getElementById('resLanguage');
  const resLangProb = document.getElementById('resLangProb');
  const resSpeechRatio = document.getElementById('resSpeechRatio');
  const resSpeechDur = document.getElementById('resSpeechDur');
  const resWordCount = document.getElementById('resWordCount');
  const resWpm = document.getElementById('resWpm');
  const resSpeakerCount = document.getElementById('resSpeakerCount');
  const resKeywordCount = document.getElementById('resKeywordCount');
  const resKeywordHits = document.getElementById('resKeywordHits');

  // Diarization Strip Elements
  const speakerDistributionBar = document.getElementById('speakerDistributionBar');
  const speakerLegendStrip = document.getElementById('speakerLegendStrip');
  const speakerFilterToggles = document.getElementById('speakerFilterToggles');

  // Synchronized Audio Player Elements
  const analysisAudioPlayer = document.getElementById('analysisAudioPlayer');
  const analysisActiveItemName = document.getElementById('analysisActiveItemName');

  // Interactive Transcript Elements
  const transcriptItemBadge = document.getElementById('transcriptItemBadge');
  const transcriptSearchInput = document.getElementById('transcriptSearchInput');
  const btnClearTranscriptSearch = document.getElementById('btnClearTranscriptSearch');
  const transcriptBody = document.getElementById('transcriptBody');

  // Export Toolbar Elements
  const btnCopyTranscript = document.getElementById('btnCopyTranscript');
  const btnExportSrt = document.getElementById('btnExportSrt');
  const btnExportVtt = document.getElementById('btnExportVtt');
  const btnExportTxt = document.getElementById('btnExportTxt');
  const btnExportJson = document.getElementById('btnExportJson');

  // Whisper Settings Modal Elements
  const whisperModal = document.getElementById('whisperModal');
  const btnCloseWhisperModal = document.getElementById('btnCloseWhisperModal');
  const btnCancelWhisperModal = document.getElementById('btnCancelWhisperModal');
  const btnSaveWhisperConfig = document.getElementById('btnSaveWhisperConfig');
  const cfgWhisperBaseUrl = document.getElementById('cfgWhisperBaseUrl');
  const cfgOpenAiKey = document.getElementById('cfgOpenAiKey');
  const cfgMaxSpeakers = document.getElementById('cfgMaxSpeakers');
  const cfgMinSegmentSec = document.getElementById('cfgMinSegmentSec');
  const whisperConfigMessage = document.getElementById('whisperConfigMessage');

  let currentAnalysisReport = null;
  let activeSpeakerFilter = 'all';

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

  let scheduledSources = [];

  function playPcmChunk(arrayBuffer) {
    if (!audioCtx || audioCtx.state !== 'running' || !isPlaying) return;

    // Convert Int16 PCM to Float32 [-1.0, 1.0]
    const int16Array = new Int16Array(arrayBuffer);
    const numSamples = int16Array.length;
    if (numSamples === 0) return;

    const numChannels = streamConfig.channels || 1;
    const frames = Math.floor(numSamples / numChannels);
    if (frames === 0) return;

    const audioBuffer = audioCtx.createBuffer(numChannels, frames, streamConfig.sampleRate);

    if (numChannels === 1) {
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < frames; i++) {
        channelData[i] = int16Array[i] / 32768.0;
      }
    } else {
      for (let ch = 0; ch < numChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          channelData[i] = int16Array[i * numChannels + ch] / 32768.0;
        }
      }
    }

    const now = audioCtx.currentTime;

    // Jitter buffer & drift compensation:
    // If nextPlayTime is behind or too far ahead, align to now + 25ms lead-in
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.025;
    } else if (nextPlayTime > now + 0.150) {
      // Latency drift detected (> 150ms buffer). Reset to prevent lag buildup!
      const targetTime = now + 0.030;
      // Stop and disconnect any already scheduled audio sources scheduled beyond targetTime to prevent overlap echo
      for (const item of scheduledSources) {
        if (item.scheduledTime >= targetTime) {
          try { item.source.stop(); } catch {}
          try { item.source.disconnect(); } catch {}
        }
      }
      scheduledSources = scheduledSources.filter(item => item.scheduledTime < targetTime);
      nextPlayTime = targetTime;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(boostGainNode);
    source.start(nextPlayTime);

    const sourceItem = { source, scheduledTime: nextPlayTime, duration: audioBuffer.duration };
    scheduledSources.push(sourceItem);
    source.onended = () => {
      const idx = scheduledSources.indexOf(sourceItem);
      if (idx !== -1) scheduledSources.splice(idx, 1);
    };

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
    if (!rect.width || !rect.height) return;
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
      // Pause visualizer render loop if Live tab is not active to save CPU/battery (REC-QA-04)
      if (viewLive && !viewLive.classList.contains('active')) {
        animationFrameId = null;
        return;
      }

      animationFrameId = requestAnimationFrame(render);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      // Clear background (true jet black)
      canvasCtx.fillStyle = '#000000';
      canvasCtx.fillRect(0, 0, width, height);

      // Draw subtle grid lines
      canvasCtx.strokeStyle = '#1a1a1a';
      canvasCtx.lineWidth = 1;
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, height / 2);
      canvasCtx.lineTo(width, height / 2);
      canvasCtx.stroke();

      if (!analyserNode || !isPlaying) {
        // Idle flat line
        canvasCtx.strokeStyle = '#262626';
        canvasCtx.beginPath();
        canvasCtx.moveTo(0, height / 2);
        canvasCtx.lineTo(width, height / 2);
        canvasCtx.stroke();
        updateVuMeter(0);
        return;
      }

      if (visualizerMode === 'waveform') {
        // Oscilloscope waveform rendering - crisp high-contrast stark white, zero neon glow
        analyserNode.getByteTimeDomainData(timeBuffer);

        canvasCtx.lineWidth = 2;
        canvasCtx.strokeStyle = '#ffffff';
        canvasCtx.shadowBlur = 0;
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
        canvasCtx.shadowBlur = 0;

        // Calculate RMS for VU meter
        const rms = Math.sqrt(sumSquares / timeBuffer.length);
        updateVuMeter(rms);

      } else {
        // Frequency spectrum bars rendering - bold solid tactical orange, zero gradients
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

          canvasCtx.fillStyle = '#ff6600';
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

    const protocols = token ? ['bandit-v1', `token.${encodeURIComponent(token)}`] : ['bandit-v1'];
    ws = new WebSocket(wsUrl, protocols);
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

      if (event.code === 4429) {
        // Rate limited
        updateConnectionUI('disconnected', 'RATE LIMITED');
        securityBadge.className = 'badge status-badge';
        securityText.textContent = 'RATE LIMITED';
        showToast('Too many authentication attempts. Please wait 5 minutes before reconnecting.', 'error');
        openAuthModal('Too many failed authentication attempts. Please wait 5 minutes before trying again.');
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
          updateConnectedDevice({ isSearching: true, message: 'Scanning host PC for microphone...' });
        } else {
          updateConnectedDevice({
            device: msg.device,
            name: msg.name || msg.deviceName,
            driver: msg.driver,
            isFallback: msg.isFallback
          });
        }
        if (msg.dspPreset) {
          updateDspUI(msg.dspPreset);
        }
        if (Array.isArray(msg.devices)) {
          renderAllMicCards(msg.devices, msg.device);
        }
        if (msg.recording) {
          updateRecordingStats(msg.recording);
          loadRecordings();
        }
      } else if (msg.type === 'pong') {
        const rtt = Math.round(performance.now() - msg.clientTime);
        currentLatencyMs = rtt;
        latencyVal.textContent = `${rtt} ms`;
      } else if (msg.type === 'devices_list') {
        if (Array.isArray(msg.devices)) {
          renderAllMicCards(msg.devices, msg.currentDevice);
        }
      } else if (msg.type === 'device_changed') {
        updateConnectedDevice({
          device: msg.device,
          name: msg.name || msg.deviceName,
          driver: msg.driver
        });
        if (typeof updateActiveCardHighlights === 'function') {
          updateActiveCardHighlights(msg.device);
        }
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
          updateConnectedDevice({ isSearching: true, message: msg.message });
        } else if (msg.isFallback) {
          updateConnectedDevice({ isFallback: true, driver: msg.driver });
        } else {
          streamHealthBadge.textContent = 'STREAMING';
          streamHealthBadge.className = 'badge badge-info';
          updateConnectedDevice({
            device: msg.device,
            name: msg.name || msg.deviceName,
            driver: msg.driver
          });
        }
      } else if (msg.type === 'device_connected') {
        streamHealthBadge.textContent = 'STREAMING';
        streamHealthBadge.className = 'badge badge-info';
        updateConnectedDevice({
          device: msg.device,
          name: msg.name || msg.deviceName,
          driver: msg.driver
        });
        showToast(`🎤 Microphone Connected: ${msg.name || msg.device}`, 'success');
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
    } else {
      // 2. Fallback to REST API if WebSocket is not connected
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
    }, 150);
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
  // Available Microphones Listing, Selection & Rescan System
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function createMicCardElement(dev, isCurrentActive) {
    const card = document.createElement('div');
    card.className = `mic-card${isCurrentActive ? ' active' : ''}`;
    card.dataset.deviceId = dev.id;
    card.dataset.driver = dev.driver || 'auto';
    card.dataset.isDefault = String(Boolean(dev.isDefault));

    let icon = '🎙️';
    if (dev.id === 'test' || dev.driver === 'lavfi') {
      icon = '📻';
    } else if (dev.driver === 'pulse' || dev.id === 'pipewire' || (dev.name && dev.name.includes('PipeWire')) || dev.isEasyEffects) {
      icon = '🎛️';
    }

    const driverLabel = (dev.driver || 'ALSA').toUpperCase();

    card.innerHTML = `
      <div class="mic-card-header">
        <div class="mic-card-left">
          <div class="mic-card-icon">${icon}</div>
          <div class="mic-card-info">
            <div class="mic-card-title" title="${escapeHtml(dev.name)}">${escapeHtml(dev.name)}</div>
            <div class="mic-card-sub">Device ID: <code>${escapeHtml(dev.id)}</code></div>
          </div>
        </div>
        <div class="mic-card-status">
          ${isCurrentActive ? '<span class="mic-badge active-status"><span class="device-dot"></span> ACTIVE</span>' : ''}
          ${dev.isDefault && !isCurrentActive ? '<span class="mic-badge default">DEFAULT</span>' : ''}
        </div>
      </div>
      ${dev.description ? `<div class="mic-card-desc">${escapeHtml(dev.description)}</div>` : ''}
      <div class="mic-card-footer">
        <div class="mic-card-badges">
          <span class="mic-badge driver">${driverLabel}</span>
          ${dev.isEasyEffects ? '<span class="mic-badge easyeffects">EASYEFFECTS</span>' : ''}
        </div>
        <button class="btn btn-sm btn-select-mic${isCurrentActive ? ' active-btn' : ''}" data-device="${escapeHtml(dev.id)}" data-driver="${escapeHtml(dev.driver || 'auto')}">
          ${isCurrentActive ? '✓ Connected' : 'Select Mic'}
        </button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      // Avoid re-selecting if already active
      if (card.classList.contains('active')) return;
      selectMicDevice(dev.id, dev.driver || 'auto', dev.name);
    });

    return card;
  }

  function updateActiveCardHighlights(activeId) {
    currentActiveDeviceId = activeId;
    document.querySelectorAll('.mic-card').forEach(c => {
      c.classList.remove('switching');
      const isAct = c.dataset.deviceId === activeId;
      c.classList.toggle('active', isAct);
      const btn = c.querySelector('.btn-select-mic');
      if (btn) {
        btn.className = `btn btn-sm btn-select-mic${isAct ? ' active-btn' : ''}`;
        btn.textContent = isAct ? '✓ Connected' : 'Select Mic';
      }
      const statusWrap = c.querySelector('.mic-card-status');
      if (statusWrap) {
        const isDef = c.dataset.isDefault === 'true';
        statusWrap.innerHTML = `
          ${isAct ? '<span class="mic-badge active-status"><span class="device-dot"></span> ACTIVE</span>' : ''}
          ${isDef && !isAct ? '<span class="mic-badge default">DEFAULT</span>' : ''}
        `;
      }
    });

    if (modalCurrentMicName && cachedDevices.length > 0) {
      const matched = cachedDevices.find(d => d.id === activeId);
      if (matched) modalCurrentMicName.textContent = matched.name;
    }
  }

  function renderAllMicCards(devices, currentDevice) {
    if (!Array.isArray(devices)) return;
    cachedDevices = devices;
    currentActiveDeviceId = currentDevice;

    if (micsCountBadge) {
      micsCountBadge.textContent = `${devices.length} DETECTED`;
    }
    if (modalCurrentMicName) {
      const activeDev = devices.find(d => d.id === currentDevice);
      modalCurrentMicName.textContent = activeDev ? activeDev.name : (currentDevice || 'Auto-detected');
    }

    // Render in main live grid
    if (micsListGrid) {
      micsListGrid.innerHTML = '';
      if (devices.length === 0) {
        micsListGrid.innerHTML = '<div class="mics-loading-placeholder">No microphones detected on host PC.</div>';
      } else {
        devices.forEach(dev => {
          const isAct = dev.id === currentDevice;
          micsListGrid.appendChild(createMicCardElement(dev, isAct));
        });
      }
    }

    // Render in modal container
    if (modalMicsListContainer) {
      modalMicsListContainer.innerHTML = '';
      if (devices.length === 0) {
        modalMicsListContainer.innerHTML = '<div class="mics-loading-placeholder">No microphones detected on host PC.</div>';
      } else {
        devices.forEach(dev => {
          const isAct = dev.id === currentDevice;
          modalMicsListContainer.appendChild(createMicCardElement(dev, isAct));
        });
      }
    }

    // Sync compact select dropdown
    if (deviceSelect) {
      deviceSelect.innerHTML = '';
      devices.forEach(dev => {
        const opt = document.createElement('option');
        opt.value = dev.id;
        opt.textContent = `${dev.name} [${dev.driver || 'alsa'}]`;
        if (dev.id === currentDevice) {
          opt.selected = true;
        }
        deviceSelect.appendChild(opt);
      });
    }
  }

  async function selectMicDevice(deviceId, driver = 'auto', deviceName = null) {
    const token = getStoredToken();
    const targetName = deviceName || deviceId;

    // Visual feedback: mark cards for this device as switching
    document.querySelectorAll(`.mic-card[data-device-id="${deviceId}"]`).forEach(c => {
      c.classList.add('switching');
      const btn = c.querySelector('.btn-select-mic');
      if (btn) btn.textContent = 'Switching...';
    });

    try {
      // 1. Send via WebSocket if connected and authenticated
      if (ws && ws.readyState === WebSocket.OPEN && ws.isAuthenticated) {
        ws.send(JSON.stringify({
          type: 'switch_device',
          device: deviceId,
          driver: driver
        }));
        currentActiveDeviceId = deviceId;
        updateConnectedDevice({
          device: deviceId,
          name: targetName,
          driver: driver
        });
        updateActiveCardHighlights(deviceId);
        showToast(`🎙️ Switched to microphone: ${targetName}`, 'success');
        return;
      }

      // 2. Fallback to REST API if WebSocket is not connected or authenticated
      const res = await fetch('/api/capture/device', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ device: deviceId, driver: driver })
      });

      if (res.ok) {
        const data = await res.json();
        const finalName = data.deviceName || targetName;
        currentActiveDeviceId = deviceId;
        updateConnectedDevice({
          device: deviceId,
          name: finalName,
          driver: data.driver || driver
        });
        updateActiveCardHighlights(deviceId);
        showToast(`🎙️ Switched to microphone: ${finalName}`, 'success');
      } else {
        document.querySelectorAll(`.mic-card[data-device-id="${deviceId}"]`).forEach(c => {
          c.classList.remove('switching');
          const btn = c.querySelector('.btn-select-mic');
          if (btn) btn.textContent = 'Select Mic';
        });
        showToast('Failed to switch microphone. Check device status.', 'error');
      }
    } catch (e) {
      document.querySelectorAll(`.mic-card[data-device-id="${deviceId}"]`).forEach(c => {
        c.classList.remove('switching');
        const btn = c.querySelector('.btn-select-mic');
        if (btn) btn.textContent = 'Select Mic';
      });
      showToast(`Error switching device: ${e.message}`, 'error');
    }
  }

  async function rescanMicrophones(triggerBtn = null) {
    if (triggerBtn) {
      const icon = triggerBtn.querySelector('.btn-icon');
      if (icon) icon.classList.add('spinning');
      triggerBtn.disabled = true;
    }
    const token = getStoredToken();
    try {
      const res = await fetch('/api/devices/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        renderAllMicCards(data.devices, data.currentDevice);
        const activeName = data.currentDeviceName || data.currentDevice;
        updateConnectedDevice({
          device: data.currentDevice,
          name: activeName,
          driver: data.currentDriver
        });
        showToast(`🔍 Rescan complete. Found ${data.devices.length} microphone device(s).`, 'success');
      } else {
        await loadDevices();
      }
    } catch {
      await loadDevices();
    } finally {
      if (triggerBtn) {
        const icon = triggerBtn.querySelector('.btn-icon');
        if (icon) icon.classList.remove('spinning');
        triggerBtn.disabled = false;
      }
    }
  }

  async function loadDevices() {
    const token = getStoredToken();
    try {
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      const res = await fetch('/api/devices', { headers });
      if (res.ok) {
        const data = await res.json();
        renderAllMicCards(data.devices, data.currentDevice);
        const matchedDev = data.devices.find(d => d.id === data.currentDevice);
        const activeName = data.currentDeviceName || matchedDev?.name || data.currentDevice;
        updateConnectedDevice({
          device: data.currentDevice,
          name: activeName,
          driver: data.currentDriver
        });
      }
    } catch {
      // ignore
    }
  }

  function openMicModal() {
    if (micModal) {
      micModal.classList.add('open');
      if (cachedDevices.length === 0) {
        loadDevices();
      } else {
        renderAllMicCards(cachedDevices, currentActiveDeviceId);
      }
    }
  }

  function closeMicModal() {
    if (micModal) {
      micModal.classList.remove('open');
    }
  }

  // Bind Microphone UI Event Listeners
  if (headerDeviceBadge) {
    headerDeviceBadge.addEventListener('click', openMicModal);
  }
  if (btnOpenMicModal) {
    btnOpenMicModal.addEventListener('click', openMicModal);
  }
  if (btnCloseMicModal) {
    btnCloseMicModal.addEventListener('click', closeMicModal);
  }
  if (btnCloseMicModalFooter) {
    btnCloseMicModalFooter.addEventListener('click', closeMicModal);
  }
  if (micModal) {
    micModal.addEventListener('click', (e) => {
      if (e.target === micModal) closeMicModal();
    });
  }
  if (btnRescanMics) {
    btnRescanMics.addEventListener('click', () => rescanMicrophones(btnRescanMics));
  }
  if (btnModalRescanMics) {
    btnModalRescanMics.addEventListener('click', () => rescanMicrophones(btnModalRescanMics));
  }
  if (btnToggleCompactSelect && deviceCompactRow) {
    btnToggleCompactSelect.addEventListener('click', () => {
      deviceCompactRow.classList.toggle('hidden');
    });
  }

  if (btnSwitchDevice && deviceSelect) {
    btnSwitchDevice.addEventListener('click', () => {
      const selected = deviceSelect.value;
      const matched = cachedDevices.find(d => d.id === selected);
      selectMicDevice(selected, matched?.driver || 'auto', matched?.name);
    });
  }

  // ---------------------------------------------------------------------------
  // Status Check & Auth Handling
  // ---------------------------------------------------------------------------

  async function checkServerStatus() {
    const token = getStoredToken();
    try {
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      const res = await fetch('/api/status', { headers });
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
  if (authModal) {
    authModal.addEventListener('click', (e) => {
      if (e.target === authModal) closeAuthModal();
    });
  }

  btnSaveToken.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    if (token) {
      btnSaveToken.disabled = true;
      btnSaveToken.textContent = 'Verifying...';
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          authErrorMessage.textContent = data.error || 'Too many attempts. Try again later.';
          btnSaveToken.disabled = false;
          btnSaveToken.textContent = 'Connect';
          return;
        }
        if (!data.valid && data.authRequired) {
          authErrorMessage.textContent = 'Invalid token. Please check your credentials.';
          btnSaveToken.disabled = false;
          btnSaveToken.textContent = 'Connect';
          return;
        }
      } catch {
        // network/offline fallback
      } finally {
        btnSaveToken.disabled = false;
        btnSaveToken.textContent = 'Connect';
      }
    }
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
      const res = await fetch('/api/recordings', {
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
              <button class="btn-rec btn-play-rec" data-file="${escapeHtml(rec.filename)}" aria-label="Play recording ${escapeHtml(rec.filename)}">▶ Play</button>
              <button class="btn-rec btn-save-rec" data-file="${escapeHtml(rec.filename)}" aria-label="Save recording ${escapeHtml(rec.filename)}">⬇ Save</button>
              ${!isCurrent ? `<button class="btn-rec btn-del-rec" data-file="${escapeHtml(rec.filename)}" aria-label="Delete recording ${escapeHtml(rec.filename)}">🗑 Del</button>` : ''}
            </div>
          </td>
        </tr>
      `;
    }

    recordingsTableBody.innerHTML = rowsHtml;

    // Populate analysis vault selector dropdown
    if (analysisVaultSelect) {
      const currentVal = analysisVaultSelect.value;
      let opts = '<option value="">Select a vault recording file...</option>';
      for (const rec of recordings) {
        opts += `<option value="${escapeHtml(rec.filename)}" ${rec.filename === currentVal ? 'selected' : ''}>${escapeHtml(rec.filename)} (${rec.sizeFormatted || ''})</option>`;
      }
      analysisVaultSelect.innerHTML = opts;
    }

    // Attach row button events
    recordingsTableBody.querySelectorAll('.btn-play-rec').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.getAttribute('data-file');
        if (file) playRecording(file);
      });
    });

    recordingsTableBody.querySelectorAll('.btn-analyze-rec').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.getAttribute('data-file');
        if (file) {
          switchTab('analysis');
          if (analysisVaultSelect) analysisVaultSelect.value = file;
          triggerVaultAnalysis(file);
        }
      });
    });

    recordingsTableBody.querySelectorAll('.btn-save-rec').forEach(btn => {
      btn.addEventListener('click', async () => {
        const file = btn.getAttribute('data-file');
        if (file) await downloadRecordingFile(file);
      });
    });

    recordingsTableBody.querySelectorAll('.btn-del-rec').forEach(btn => {
      btn.addEventListener('click', () => {
        const file = btn.getAttribute('data-file');
        if (file) deleteRecording(file);
      });
    });
  }

  async function getMediaStreamUrl(filename) {
    const token = getStoredToken();
    if (!token) {
      return `/api/recordings/${encodeURIComponent(filename)}`;
    }
    try {
      const res = await fetch('/api/auth/media-ticket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ filename })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ticket) {
          return `/api/recordings/${encodeURIComponent(filename)}?ticket=${encodeURIComponent(data.ticket)}`;
        }
      }
    } catch {}
    return `/api/recordings/${encodeURIComponent(filename)}`;
  }

  async function playRecording(filename) {
    const url = await getMediaStreamUrl(filename);
    if (vaultPlayerTitle) {
      vaultPlayerTitle.textContent = filename;
    }
    if (vaultAudioPlayer) {
      vaultAudioPlayer.src = url;
      vaultAudioPlayer.play().catch(e => console.warn('[Vault] Playback trigger warning:', e));
    }
  }

  async function downloadRecordingFile(filename) {
    const streamUrl = await getMediaStreamUrl(filename);
    const downloadUrl = `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}download=1`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // In-App Delete Confirmation Modal Management (REC-QA-02)
  let pendingDeleteFilename = null;

  function openDeleteModal(filename) {
    if (!deleteConfirmModal) return;
    pendingDeleteFilename = filename;
    if (deleteTargetFilename) deleteTargetFilename.textContent = filename;
    deleteConfirmModal.classList.add('open');
    if (btnConfirmDelete) btnConfirmDelete.focus();
  }

  function closeDeleteModal() {
    if (!deleteConfirmModal) return;
    deleteConfirmModal.classList.remove('open');
    pendingDeleteFilename = null;
  }

  if (btnCloseDeleteModal) btnCloseDeleteModal.addEventListener('click', closeDeleteModal);
  if (btnCancelDelete) btnCancelDelete.addEventListener('click', closeDeleteModal);
  if (deleteConfirmModal) {
    deleteConfirmModal.addEventListener('click', (e) => {
      if (e.target === deleteConfirmModal) closeDeleteModal();
    });
  }
  if (btnConfirmDelete) {
    btnConfirmDelete.addEventListener('click', async () => {
      if (pendingDeleteFilename) {
        const fileToDelete = pendingDeleteFilename;
        closeDeleteModal();
        await executeDeleteRecording(fileToDelete);
      }
    });
  }

  function deleteRecording(filename) {
    openDeleteModal(filename);
  }

  async function executeDeleteRecording(filename) {
    const token = getStoredToken();
    try {
      const res = await fetch(`/api/recordings/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        showToast(`Recording "${filename}" deleted successfully`, 'success');
        loadRecordings();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to delete recording', 'error');
      }
    } catch (e) {
      showToast('Delete error: ' + e.message, 'error');
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

  // ===========================================================================
  // Top Navigation & Tab Switching
  // ===========================================================================

  const tabViewsMap = {
    live: viewLive,
    vault: viewVault,
    analysis: viewAnalysis
  };

  function switchTab(tabId) {
    navTabs.forEach(tab => {
      const isTarget = tab.getAttribute('data-tab') === tabId;
      if (isTarget) {
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
      } else {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
      }
    });

    Object.keys(tabViewsMap).forEach(key => {
      const view = tabViewsMap[key];
      if (view) {
        if (key === tabId) {
          view.classList.add('active');
        } else {
          view.classList.remove('active');
        }
      }
    });

    if (tabId === 'live') {
      requestAnimationFrame(() => {
        resizeCanvas();
        if (isPlaying && !animationFrameId) {
          startVisualizerLoop();
        }
      });
    } else {
      // Pause visualizer render loop when leaving Live tab (REC-QA-04)
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    }

    if (tabId === 'analysis') {
      loadAnalysisConfig();
    }
  }

  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.getAttribute('data-tab');
      if (target) switchTab(target);
    });
  });

  if (btnQuick30sLive) {
    btnQuick30sLive.addEventListener('click', () => {
      switchTab('analysis');
      triggerLiveSnapshotAnalysis(30);
    });
  }

  // ===========================================================================
  // Audio Analysis & OpenAI Whisper STT Controller
  // ===========================================================================

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  async function loadAnalysisConfig() {
    const token = getStoredToken();
    try {
      const res = await fetch('/api/analysis/config', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (res.ok) {
        const data = await res.json();
        updateEngineBadges(data);
      }
    } catch (e) {
      console.warn('[Analysis] Config check warning:', e);
    }
  }

  function updateEngineBadges(cfg) {
    if (!whisperEngineBadge) return;
    if (cfg.activeEngine === 'local_whisper') {
      whisperEngineBadge.textContent = '● LOCAL WHISPER (SMALL)';
      whisperEngineBadge.style.color = '#ff6600';
      whisperEngineBadge.style.borderColor = '#ff6600';
    } else if (cfg.activeEngine === 'openai_cloud') {
      whisperEngineBadge.textContent = '☁️ OPENAI CLOUD (WHISPER-1)';
      whisperEngineBadge.style.color = '#ffffff';
      whisperEngineBadge.style.borderColor = '#ffffff';
    } else {
      whisperEngineBadge.textContent = '● REAL ACOUSTIC ANALYZER (FFMPEG)';
      whisperEngineBadge.style.color = '#33cc66';
      whisperEngineBadge.style.borderColor = '#33cc66';
    }

    if (whisperModelBadge) {
      if (cfg.activeEngine === 'real_acoustic_analyzer') {
        whisperModelBadge.textContent = `FFmpeg Acoustic Signal // ${cfg.maxSpeakers || 4}-Spk Diarization (≥ ${cfg.minSegmentSec || 0.8}s)`;
      } else {
        whisperModelBadge.textContent = `int8 CPU // ${cfg.maxSpeakers || 4}-Spk Diarization (≥ ${cfg.minSegmentSec || 0.8}s)`;
      }
    }
  }

  async function triggerLiveSnapshotAnalysis(seconds = 30) {
    if (!analysisProgressBanner) return;
    analysisProgressBanner.classList.remove('hidden');
    analysisProgressTitle.textContent = `Capturing & Transcribing Last ${seconds}s Live Mic...`;
    analysisProgressSubtext.textContent = 'Running faster-whisper CTranslate2 int8 inference, extracting word timestamps, and clustering up to 4 speakers (≥ 0.8s threshold)...';

    const token = getStoredToken();
    try {
      const res = await fetch('/api/analysis/live-snapshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          seconds,
          language: analysisLanguageSelect?.value || 'auto',
          keywords: analysisKeywordsInput?.value || '',
          maxSpeakers: parseInt(analysisMaxSpeakers?.value || '4', 10),
          minSegmentSec: 0.8
        })
      });

      analysisProgressBanner.classList.add('hidden');

      if (res.ok) {
        const data = await res.json();
        renderAnalysisReport(data.report);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to analyze live stream audio', 'error');
      }
    } catch (e) {
      analysisProgressBanner.classList.add('hidden');
      showToast('Analysis error: ' + e.message, 'error');
    }
  }

  async function triggerVaultAnalysis(filename) {
    if (!filename) return;
    if (!analysisProgressBanner) return;
    analysisProgressBanner.classList.remove('hidden');
    analysisProgressTitle.textContent = `Transcribing "${filename}" with Whisper...`;
    analysisProgressSubtext.textContent = 'Downsampling with FFmpeg to 16kHz mono, generating word timestamps, and clustering speakers...';

    const token = getStoredToken();
    try {
      const res = await fetch('/api/analysis/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          filename,
          language: analysisLanguageSelect?.value || 'auto',
          keywords: analysisKeywordsInput?.value || '',
          maxSpeakers: parseInt(analysisMaxSpeakers?.value || '4', 10),
          minSegmentSec: 0.8
        })
      });

      analysisProgressBanner.classList.add('hidden');

      if (res.ok) {
        const data = await res.json();
        renderAnalysisReport(data.report);
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to transcribe vault recording', 'error');
      }
    } catch (e) {
      analysisProgressBanner.classList.add('hidden');
      showToast('Transcription error: ' + e.message, 'error');
    }
  }

  function renderAnalysisReport(report) {
    if (!report) return;
    currentAnalysisReport = report;
    activeSpeakerFilter = 'all';

    if (analysisResultsWorkspace) {
      analysisResultsWorkspace.classList.remove('hidden');
    }

    if (analysisActiveItemName) {
      analysisActiveItemName.textContent = report.filename;
    }

    // Bind audio player
    if (analysisAudioPlayer) {
      getMediaStreamUrl(report.filename).then(url => {
        analysisAudioPlayer.src = url;
      });
    }

    // Populate Metrics
    const m = report.metrics || {};
    if (resLanguage) resLanguage.textContent = (report.language || 'EN').toUpperCase();
    if (resLangProb) resLangProb.textContent = `${Math.round((report.languageProbability || 1) * 100)}% confidence`;
    if (resSpeechRatio) resSpeechRatio.textContent = `${m.speechActivityRatio || 0}%`;
    if (resSpeechDur) resSpeechDur.textContent = `${m.speechDuration || 0}s speech / ${m.silenceDuration || 0}s silence`;
    if (resWordCount) resWordCount.textContent = `${m.wordCount || 0} words`;
    if (resWpm) resWpm.textContent = `${m.wordsPerMinute || 0} WPM`;
    if (resSpeakerCount) resSpeakerCount.textContent = `${m.speakers?.length || 1} Speakers`;
    if (resKeywordCount) resKeywordCount.textContent = m.keywordMatchesCount || 0;
    if (resKeywordHits) resKeywordHits.textContent = `${m.keywordMatchesCount || 0} watchlist hits`;

    // Render Speaker Diarization Breakdown
    renderDiarization(report);

    // Render Interactive Transcript
    renderTranscript(report);
  }

  function getSpeakerIndex(speakerName) {
    const match = (speakerName || '').match(/Speaker\s*(\d+)/i);
    return match ? parseInt(match[1], 10) : 1;
  }

  function renderDiarization(report) {
    if (!speakerDistributionBar || !speakerLegendStrip || !speakerFilterToggles) return;

    const breakdown = report.metrics?.speakerBreakdown || {};
    const speakers = Object.keys(breakdown);

    // Distribution Bar
    let barHtml = '';
    let legendHtml = '';
    let filterHtml = '<button class="speaker-filter-btn active" data-speaker="all">All Speakers</button>';

    speakers.forEach(spk => {
      const info = breakdown[spk];
      const spkIdx = getSpeakerIndex(spk);
      const pct = info.percentage || `${Math.round(info.ratio * 100)}%`;
      const widthPct = Math.max(3, Math.round(info.ratio * 100));

      barHtml += `<div class="speaker-bar-seg spk-${spkIdx}" style="width: ${widthPct}%" title="${escapeHtml(spk)}: ${pct} (${info.seconds}s)"></div>`;
      legendHtml += `
        <div class="speaker-legend-item">
          <span class="speaker-dot spk-${spkIdx}"></span>
          <span><strong>${escapeHtml(spk)}:</strong> ${pct} (${info.seconds}s)</span>
        </div>
      `;
      filterHtml += `<button class="speaker-filter-btn" data-speaker="${escapeHtml(spk)}">${escapeHtml(spk)}</button>`;
    });

    speakerDistributionBar.innerHTML = barHtml || '<div class="speaker-bar-seg spk-1" style="width: 100%"></div>';
    speakerLegendStrip.innerHTML = legendHtml || '<div class="speaker-legend-item"><span class="speaker-dot spk-1"></span> Speaker 1 (100%)</div>';
    speakerFilterToggles.innerHTML = filterHtml;

    // Filter toggle listeners
    speakerFilterToggles.querySelectorAll('.speaker-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        speakerFilterToggles.querySelectorAll('.speaker-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeSpeakerFilter = btn.getAttribute('data-speaker') || 'all';
        applyTranscriptFilters();
      });
    });
  }

  function renderTranscript(report) {
    if (!transcriptBody) return;
    const segments = report.segments || [];

    if (transcriptItemBadge) {
      transcriptItemBadge.textContent = `${segments.length} Segments`;
    }

    if (segments.length === 0) {
      transcriptBody.innerHTML = '<div class="empty-row" style="padding: 20px; text-align: center; color: var(--text-dim);">No speech detected in this audio segment.</div>';
      return;
    }

    // Determine flagged keywords
    const kwMatches = new Set((report.metrics?.keywordMatches || []).map(m => (m.keyword || '').toLowerCase()));

    let html = '';
    segments.forEach(seg => {
      const spkIdx = getSpeakerIndex(seg.speaker);
      const timeStr = formatTime(seg.start);

      // Render words with spans
      let wordsHtml = '';
      if (seg.words && seg.words.length > 0) {
        seg.words.forEach(w => {
          const cleanWord = (w.word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const isKw = kwMatches.has(cleanWord);
          wordsHtml += `<span class="transcript-word ${isKw ? 'keyword-hit' : ''}" data-start="${w.start}" data-end="${w.end}" title="[${w.start}s - ${w.end}s]">${escapeHtml(w.word)}</span> `;
        });
      } else {
        wordsHtml = escapeHtml(seg.text);
      }

      html += `
        <div class="transcript-segment-row" data-segment-id="${seg.id}" data-start="${seg.start}" data-end="${seg.end}" data-speaker="${escapeHtml(seg.speaker || 'Speaker 1')}">
          <div class="segment-meta">
            <button class="segment-time-btn" data-time="${seg.start}">[${timeStr}]</button>
            <span class="segment-speaker-badge spk-${spkIdx}">${escapeHtml(seg.speaker || 'Speaker 1')}</span>
          </div>
          <div class="segment-text-content">
            ${wordsHtml}
          </div>
        </div>
      `;
    });

    transcriptBody.innerHTML = html;

    // Attach click-to-seek listeners
    transcriptBody.querySelectorAll('.segment-time-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = parseFloat(btn.getAttribute('data-time'));
        if (!isNaN(t) && analysisAudioPlayer) {
          analysisAudioPlayer.currentTime = t;
          analysisAudioPlayer.play().catch(() => {});
        }
      });
    });

    transcriptBody.querySelectorAll('.transcript-word').forEach(wordEl => {
      wordEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = parseFloat(wordEl.getAttribute('data-start'));
        if (!isNaN(t) && analysisAudioPlayer) {
          analysisAudioPlayer.currentTime = t;
          analysisAudioPlayer.play().catch(() => {});
        }
      });
    });
  }

  // Synchronized Karaoke-style word glow and segment highlight
  if (analysisAudioPlayer) {
    analysisAudioPlayer.addEventListener('timeupdate', () => {
      const cur = analysisAudioPlayer.currentTime;
      if (!transcriptBody) return;

      // 1. Highlight active segment row
      let activeRow = null;
      transcriptBody.querySelectorAll('.transcript-segment-row').forEach(row => {
        const start = parseFloat(row.getAttribute('data-start'));
        const end = parseFloat(row.getAttribute('data-end'));
        if (cur >= start && cur <= end) {
          row.classList.add('active-segment');
          activeRow = row;
        } else {
          if (row.classList.contains('active-segment')) {
            row.classList.remove('active-segment');
            row.querySelectorAll('.active-word').forEach(w => w.classList.remove('active-word'));
          }
        }
      });

      // 2. Highlight active word span scoped to active segment row
      if (activeRow) {
        activeRow.querySelectorAll('.transcript-word').forEach(wEl => {
          const start = parseFloat(wEl.getAttribute('data-start'));
          const end = parseFloat(wEl.getAttribute('data-end'));
          if (cur >= start && cur <= end) {
            wEl.classList.add('active-word');
          } else {
            wEl.classList.remove('active-word');
          }
        });
      }
    });
  }

  function applyTranscriptFilters() {
    if (!transcriptBody) return;
    const searchVal = (transcriptSearchInput?.value || '').toLowerCase().trim();

    transcriptBody.querySelectorAll('.transcript-segment-row').forEach(row => {
      const spk = row.getAttribute('data-speaker') || '';
      const text = row.querySelector('.segment-text-content')?.textContent.toLowerCase() || '';

      const matchesSpeaker = (activeSpeakerFilter === 'all' || spk === activeSpeakerFilter);
      const matchesSearch = !searchVal || text.includes(searchVal);

      if (matchesSpeaker && matchesSearch) {
        row.style.display = 'flex';
      } else {
        row.style.display = 'none';
      }
    });
  }

  if (transcriptSearchInput) {
    transcriptSearchInput.addEventListener('input', applyTranscriptFilters);
  }
  if (btnClearTranscriptSearch) {
    btnClearTranscriptSearch.addEventListener('click', () => {
      if (transcriptSearchInput) transcriptSearchInput.value = '';
      applyTranscriptFilters();
    });
  }

  if (btnAnalyzeLive30s) {
    btnAnalyzeLive30s.addEventListener('click', () => triggerLiveSnapshotAnalysis(30));
  }

  if (btnAnalyzeVaultFile) {
    btnAnalyzeVaultFile.addEventListener('click', () => {
      const file = analysisVaultSelect?.value;
      if (file) {
        triggerVaultAnalysis(file);
      } else {
        showToast('Please select a vault recording file to analyze.', 'warning');
      }
    });
  }

  // Export actions
  if (btnCopyTranscript) {
    btnCopyTranscript.addEventListener('click', () => {
      if (!currentAnalysisReport?.fullText) {
        showToast('No transcript to copy.', 'warning');
        return;
      }
      navigator.clipboard.writeText(currentAnalysisReport.fullText)
        .then(() => showToast('Transcript copied to clipboard!', 'success'))
        .catch(() => showToast('Failed to copy to clipboard.', 'error'));
    });
  }

  async function downloadExport(format) {
    if (!currentAnalysisReport?.id) {
      showToast('No active analysis to export.', 'warning');
      return;
    }
    const token = getStoredToken();
    const filename = `${currentAnalysisReport.id}.${format}`;
    try {
      const res = await fetch(`/api/analysis/jobs/${encodeURIComponent(currentAnalysisReport.id)}/export/${format}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        showToast(`Downloaded ${filename}`, 'success');
        return;
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to export file', 'error');
        return;
      }
    } catch (e) {
      console.warn('[Export] Download error:', e);
      showToast('Download error: ' + e.message, 'error');
    }
  }

  if (btnExportSrt) btnExportSrt.addEventListener('click', () => downloadExport('srt'));
  if (btnExportVtt) btnExportVtt.addEventListener('click', () => downloadExport('vtt'));
  if (btnExportTxt) btnExportTxt.addEventListener('click', () => downloadExport('txt'));
  if (btnExportJson) btnExportJson.addEventListener('click', () => downloadExport('json'));

  // Native Web Speech Recognition Integration
  let speechRecognition = null;
  let isWebSpeechRunning = false;
  const btnToggleWebSpeech = document.getElementById('btnToggleWebSpeech');
  const webSpeechBtnText = document.getElementById('webSpeechBtnText');
  const webSpeechStatusText = document.getElementById('webSpeechStatusText');

  function initWebSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      if (webSpeechStatusText) webSpeechStatusText.textContent = 'Browser STT: Not supported in this browser';
      if (btnToggleWebSpeech) btnToggleWebSpeech.disabled = true;
      showToast('Web Speech API is not supported in this browser.', 'warning');
      return;
    }

    speechRecognition = new SpeechRec();
    speechRecognition.continuous = true;
    speechRecognition.interimResults = false;
    speechRecognition.lang = (analysisLanguageSelect?.value && analysisLanguageSelect.value !== 'auto') ? analysisLanguageSelect.value : 'en-US';

    speechRecognition.onstart = () => {
      isWebSpeechRunning = true;
      if (webSpeechBtnText) webSpeechBtnText.textContent = 'Stop Real-Time Dictation';
      if (webSpeechStatusText) webSpeechStatusText.textContent = 'Browser STT: Active (Listening)';
      if (btnToggleWebSpeech) btnToggleWebSpeech.classList.add('active');
      showToast('Browser Speech Recognition active: speaking into mic will populate transcript.', 'info');
    };

    speechRecognition.onresult = (event) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        }
      }
      if (finalTranscript.trim()) {
        appendLiveSpeechTranscript(finalTranscript.trim());
      }
    };

    speechRecognition.onerror = (err) => {
      console.warn('[WebSpeech Error]', err.error);
      if (webSpeechStatusText) webSpeechStatusText.textContent = `Browser STT: ${err.error}`;
      if (err.error === 'not-allowed') {
        showToast('Microphone access denied for browser speech recognition.', 'error');
      }
    };

    speechRecognition.onend = () => {
      isWebSpeechRunning = false;
      if (webSpeechBtnText) webSpeechBtnText.textContent = 'Start Real-Time Dictation';
      if (webSpeechStatusText) webSpeechStatusText.textContent = 'Browser STT: Standby';
      if (btnToggleWebSpeech) btnToggleWebSpeech.classList.remove('active');
    };
  }

  function appendLiveSpeechTranscript(spokenText) {
    if (!currentAnalysisReport) {
      currentAnalysisReport = {
        id: `live_speech_${Date.now()}`,
        filename: 'live_microphone_speech.mp3',
        analyzedAt: new Date().toISOString(),
        model: 'browser-native-stt',
        language: speechRecognition?.lang || 'en',
        languageProbability: 0.99,
        fullText: spokenText,
        metrics: {
          totalDuration: 5,
          speechDuration: 5,
          silenceDuration: 0,
          speechActivityRatio: 100,
          wordCount: spokenText.split(/\s+/).length,
          wordsPerMinute: 140,
          keywordMatchesCount: 0,
          keywordMatches: [],
          speakers: ['Speaker 1'],
          speakerBreakdown: { 'Speaker 1': { seconds: 5, ratio: 1, percentage: '100%' } }
        },
        segments: []
      };
      if (analysisResultsWorkspace) analysisResultsWorkspace.classList.remove('hidden');
    }

    const wordsList = spokenText.split(/\s+/).filter(Boolean);
    const startT = currentAnalysisReport.segments.length > 0
      ? currentAnalysisReport.segments[currentAnalysisReport.segments.length - 1].end + 0.5
      : 0.0;
    const dur = Math.max(0.8, Math.round(wordsList.length * 0.4 * 10) / 10);
    const endT = Math.round((startT + dur) * 100) / 100;
    const wDur = dur / wordsList.length;

    let wCur = startT;
    const words = wordsList.map(w => {
      const item = {
        word: w,
        start: Math.round(wCur * 100) / 100,
        end: Math.round((wCur + wDur * 0.9) * 100) / 100,
        probability: 0.98,
        speaker: 'Speaker 1'
      };
      wCur += wDur;
      return item;
    });

    currentAnalysisReport.segments.push({
      id: currentAnalysisReport.segments.length,
      seek: Math.floor(startT),
      start: startT,
      end: endT,
      text: spokenText,
      speaker: 'Speaker 1',
      words
    });

    currentAnalysisReport.fullText = currentAnalysisReport.segments.map(s => s.text).join(' ');
    currentAnalysisReport.metrics.wordCount = currentAnalysisReport.segments.reduce((acc, s) => acc + (s.words ? s.words.length : 0), 0);
    currentAnalysisReport.metrics.totalDuration = endT;
    currentAnalysisReport.metrics.speechDuration = endT;

    renderAnalysisReport(currentAnalysisReport);
  }

  if (btnToggleWebSpeech) {
    btnToggleWebSpeech.addEventListener('click', () => {
      if (!speechRecognition) initWebSpeechRecognition();
      if (!speechRecognition) return;
      if (isWebSpeechRunning) {
        speechRecognition.stop();
      } else {
        speechRecognition.lang = (analysisLanguageSelect?.value && analysisLanguageSelect.value !== 'auto') ? analysisLanguageSelect.value : 'en-US';
        try {
          speechRecognition.start();
        } catch (e) {
          console.warn('[WebSpeech Start Error]', e.message);
        }
      }
    });
  }

  // Whisper Settings Modal
  if (btnConfigWhisper) {
    btnConfigWhisper.addEventListener('click', async () => {
      const token = getStoredToken();
      try {
        const res = await fetch('/api/analysis/config', {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const cfg = await res.json();
          if (cfgWhisperBaseUrl) cfgWhisperBaseUrl.value = cfg.localEndpoint || '';
          if (cfgMaxSpeakers) cfgMaxSpeakers.value = cfg.maxSpeakers || 4;
          if (cfgMinSegmentSec) cfgMinSegmentSec.value = cfg.minSegmentSec || 0.8;
        }
      } catch {}
      if (whisperModal) whisperModal.classList.add('open');
    });
  }

  if (btnCloseWhisperModal) {
    btnCloseWhisperModal.addEventListener('click', () => whisperModal?.classList.remove('open'));
  }
  if (btnCancelWhisperModal) {
    btnCancelWhisperModal.addEventListener('click', () => whisperModal?.classList.remove('open'));
  }
  if (whisperModal) {
    whisperModal.addEventListener('click', (e) => {
      if (e.target === whisperModal) whisperModal.classList.remove('open');
    });
  }
  if (btnSaveWhisperConfig) {
    btnSaveWhisperConfig.addEventListener('click', async () => {
      const token = getStoredToken();
      const payload = {
        whisperBaseUrl: cfgWhisperBaseUrl?.value ? cfgWhisperBaseUrl.value.trim() : undefined,
        openaiApiKey: cfgOpenAiKey ? cfgOpenAiKey.value.trim() : '',
        maxSpeakers: parseInt(cfgMaxSpeakers?.value || '4', 10),
        minSegmentSec: parseFloat(cfgMinSegmentSec?.value || '0.8')
      };
      try {
        const res = await fetch('/api/analysis/config', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          whisperModal?.classList.remove('open');
          loadAnalysisConfig();
        } else {
          const err = await res.json().catch(() => ({}));
          if (whisperConfigMessage) whisperConfigMessage.textContent = err.error || 'Failed to save config';
        }
      } catch (e) {
        if (whisperConfigMessage) whisperConfigMessage.textContent = e.message;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Mutual Audio Exclusion & Accessibility Enhancements
  // ---------------------------------------------------------------------------

  let isLiveAudioDucked = false;

  function duckLiveAudio() {
    if (masterGainNode && audioCtx && !isLiveAudioDucked && isPlaying) {
      isLiveAudioDucked = true;
      masterGainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      showToast('Live mic audio paused for recorded media playback', 'info');
      announceLiveMessage('Live audio monitoring muted for media playback');
    }
  }

  function unduckLiveAudio() {
    const vaultPlaying = vaultAudioPlayer && !vaultAudioPlayer.paused && !vaultAudioPlayer.ended;
    const analysisPlaying = analysisAudioPlayer && !analysisAudioPlayer.paused && !analysisAudioPlayer.ended;
    if (!vaultPlaying && !analysisPlaying && isLiveAudioDucked) {
      isLiveAudioDucked = false;
      if (masterGainNode && audioCtx) {
        const targetGain = isMuted ? 0 : parseFloat(volumeSlider.value);
        masterGainNode.gain.setValueAtTime(targetGain, audioCtx.currentTime);
      }
      announceLiveMessage('Live audio monitoring restored');
    }
  }

  if (vaultAudioPlayer) {
    vaultAudioPlayer.addEventListener('play', () => {
      if (analysisAudioPlayer && !analysisAudioPlayer.paused) {
        analysisAudioPlayer.pause();
      }
      duckLiveAudio();
    });
    vaultAudioPlayer.addEventListener('pause', unduckLiveAudio);
    vaultAudioPlayer.addEventListener('ended', unduckLiveAudio);
  }

  if (analysisAudioPlayer) {
    analysisAudioPlayer.addEventListener('play', () => {
      if (vaultAudioPlayer && !vaultAudioPlayer.paused) {
        vaultAudioPlayer.pause();
      }
      duckLiveAudio();
    });
    analysisAudioPlayer.addEventListener('pause', unduckLiveAudio);
    analysisAudioPlayer.addEventListener('ended', unduckLiveAudio);
  }

  // Focus Trapping for Accessible Modals (WCAG 2.4.3)
  function trapFocus(modalElement) {
    if (!modalElement) return;
    const focusable = modalElement.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    modalElement.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (document.activeElement === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    });
  }

  [authModal, whisperModal, micModal, deleteConfirmModal].forEach(m => {
    if (m) trapFocus(m);
  });

  // Global Escape Key Dismissal for All Modals (UX-04 / REC-QA-02)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (authModal?.classList.contains('open')) closeAuthModal();
      if (micModal?.classList.contains('open')) closeMicModal();
      if (whisperModal?.classList.contains('open')) whisperModal.classList.remove('open');
      if (deleteConfirmModal?.classList.contains('open')) closeDeleteModal();
    }
  });

  function announceLiveMessage(text) {
    const el = document.getElementById('liveAnnouncer');
    if (el) el.textContent = text;
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
