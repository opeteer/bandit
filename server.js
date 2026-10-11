/**
 * Bandit - Low Latency Audio Surveillance Server
 * Express + WebSocket + FFmpeg Audio Pipeline
 */

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const AudioCapture = require('./src/audioCapture');
const RecordingManager = require('./src/recordingManager');
const WhisperAnalyzer = require('./src/whisperAnalyzer');
const { isValidToken, extractToken, authMiddleware, generateMediaTicket, isValidMediaTicket } = require('./src/auth');
const { scanAudioDevices, getDeviceDisplayName } = require('./src/deviceScanner');
const { DSP_PRESETS, getDspPresetsList } = require('./src/dspFilters');

const PORT = parseInt(process.env.PORT || '8099', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CAPTURE_MODE = (process.env.CAPTURE_MODE || 'continuous').toLowerCase();
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();

// Initialize Express
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize HTTP & WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => {
    if (protocols.has('bandit-v1')) return 'bandit-v1';
    return false;
  }
});

// Initialize Audio Capture Supervisor
const audioCapture = new AudioCapture({
  device: process.env.AUDIO_DEVICE || 'auto',
  driver: process.env.AUDIO_DRIVER || 'auto',
  sampleRate: process.env.SAMPLE_RATE || '24000',
  channels: process.env.CHANNELS || '1',
  chunkMs: process.env.CHUNK_MS || '40',
  dspPreset: process.env.DSP_PRESET || 'broadcast'
});

// Initialize 48-Hour Automatic Recording Manager
const recordingManager = new RecordingManager({
  recordingsDir: process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings'),
  enabled: process.env.AUTO_RECORDING_ENABLED !== 'false',
  segmentDurationSeconds: process.env.RECORDING_SEGMENT_SECONDS || '3600',
  retentionHours: process.env.RECORDING_RETENTION_HOURS || '48',
  format: process.env.RECORDING_FORMAT || 'mp3',
  bitrate: process.env.RECORDING_BITRATE || '64k',
  sampleRate: process.env.SAMPLE_RATE || '24000',
  channels: process.env.CHANNELS || '1'
});

// Initialize Local Whisper STT & Audio Analysis Engine
const whisperAnalyzer = new WhisperAnalyzer({
  whisperBaseUrl: process.env.WHISPER_BASE_URL || 'http://localhost:9099/v1',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  model: process.env.WHISPER_MODEL || 'small',
  maxSpeakers: process.env.WHISPER_MAX_SPEAKERS || '4',
  minSegmentSec: process.env.WHISPER_MIN_SEGMENT_SEC || '0.8',
  recordingsDir: process.env.RECORDINGS_DIR || path.join(__dirname, 'recordings')
});

const clients = new Set();
let onDemandStopTimeout = null;

// Audio chunk broadcast & recording
audioCapture.on('data', (chunk) => {
  // Feed 48-hour continuous rolling recording system
  recordingManager.writeChunk(chunk);

  if (clients.size === 0) return;

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && ws.isAuthenticated) {
      // Prevent latency accumulation: if client buffer is backed up, skip packet
      if (ws.bufferedAmount > 65536) {
        // Client network is lagging, drop frame to maintain real-time low latency
        continue;
      }
      try {
        ws.send(chunk, { binary: true });
      } catch (err) {
        console.error('[Server] Error broadcasting audio chunk:', err.message);
      }
    }
  }
});

// Broadcast status events to connected clients
audioCapture.on('status', (status) => {
  broadcastControlMessage({ type: 'capture_status', ...status });
});

audioCapture.on('device_connected', (dev) => {
  console.log(`[Server] Microphone connected: ${dev.name} (${dev.device})`);
  broadcastControlMessage({ type: 'device_connected', ...dev });
});

audioCapture.on('dsp_changed', (dspData) => {
  console.log(`[Server] EasyEffects DSP preset switched to: ${dspData.preset}`);
  broadcastControlMessage({ type: 'dsp_changed', ...dspData });
});

audioCapture.on('dsp_error', (dspError) => {
  console.warn(`[Server] EasyEffects DSP Error: ${dspError.message}`);
  broadcastControlMessage({ type: 'dsp_error', ...dspError });
});

audioCapture.on('error', (err) => {
  broadcastControlMessage({ type: 'capture_error', ...err });
});

// Recording Manager Events
recordingManager.on('segment_started', (data) => {
  broadcastControlMessage({ type: 'recording_segment_started', ...data });
});

recordingManager.on('segment_saved', (data) => {
  broadcastControlMessage({ type: 'recording_segment_saved', ...data });
});

recordingManager.on('recordings_purged', (data) => {
  broadcastControlMessage({ type: 'recordings_purged', ...data });
});

recordingManager.on('status_changed', (data) => {
  broadcastControlMessage({ type: 'recording_status_changed', ...data });
});

function broadcastControlMessage(data) {
  const json = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN && ws.isAuthenticated) {
      try {
        ws.send(json);
      } catch {
        // ignore
      }
    }
  }
}

// -----------------------------------------------------------------------------
// REST API Endpoints
// -----------------------------------------------------------------------------

// System Status endpoint
app.get('/api/status', (req, res) => {
  const authRequired = Boolean(AUTH_TOKEN);
  const token = extractToken(req);
  const isAuth = !authRequired || isValidToken(token);

  res.json({
    appName: 'Bandit Audio Surveillance',
    version: '1.0.0',
    authRequired,
    isAuthenticated: isAuth,
    activeListeners: clients.size,
    captureMode: CAPTURE_MODE,
    audio: audioCapture.getStatus(),
    recording: recordingManager.listRecordings().stats,
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptimeSeconds: Math.floor(process.uptime())
    }
  });
});

// Auth Verification endpoint
app.post('/api/auth/verify', (req, res) => {
  const token = req.body?.token || '';
  if (!AUTH_TOKEN) {
    return res.json({ valid: true, authRequired: false });
  }

  const valid = isValidToken(token);
  return res.json({ valid, authRequired: true });
});

// Request short-lived media ticket for playback elements (prevents leaking token in URLs)
app.post('/api/auth/media-ticket', authMiddleware, (req, res) => {
  const { filename } = req.body || {};
  const safeFilename = filename ? path.basename(filename) : '*';
  const ticket = generateMediaTicket(safeFilename, 120);
  res.json({ success: true, ticket });
});

// Device List endpoint (protected if auth enabled)
app.get('/api/devices', (req, res) => {
  if (AUTH_TOKEN) {
    const token = extractToken(req);
    if (!isValidToken(token)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Valid token required' });
    }
  }

  try {
    const rawDevices = scanAudioDevices();
    const currentDeviceName = audioCapture.deviceName || getDeviceDisplayName(audioCapture.device);
    const devices = rawDevices.map(d => ({
      ...d,
      isActive: d.id === audioCapture.device
    }));
    res.json({
      devices,
      currentDevice: audioCapture.device,
      currentDeviceName,
      currentDriver: audioCapture.driver
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to scan devices', message: err.message });
  }
});

// Rescan Devices endpoint (protected if auth enabled)
app.post('/api/devices/scan', authMiddleware, (req, res) => {
  try {
    const rawDevices = scanAudioDevices();
    const currentDeviceName = audioCapture.deviceName || getDeviceDisplayName(audioCapture.device);
    const devices = rawDevices.map(d => ({
      ...d,
      isActive: d.id === audioCapture.device
    }));
    // Broadcast fresh device list to all connected clients
    broadcastControlMessage({
      type: 'devices_list',
      devices,
      currentDevice: audioCapture.device,
      currentDeviceName,
      currentDriver: audioCapture.driver
    });
    res.json({
      devices,
      currentDevice: audioCapture.device,
      currentDeviceName,
      currentDriver: audioCapture.driver
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rescan devices', message: err.message });
  }
});

// Switch Device endpoint (protected)
app.post('/api/capture/device', authMiddleware, (req, res) => {
  const { device, driver } = req.body || {};
  if (!device) {
    return res.status(400).json({ error: 'Missing device parameter' });
  }

  const devices = scanAudioDevices();
  const validIds = devices.map(d => d.id);
  if (device !== 'auto' && device !== 'test' && !validIds.includes(device)) {
    return res.status(400).json({
      error: 'Invalid audio device',
      validDevices: ['auto', ...validIds]
    });
  }

  const matched = devices.find(d => d.id === device);
  const deviceName = matched ? matched.name : getDeviceDisplayName(device);
  const finalDriver = driver || (matched?.driver || 'auto');

  console.log(`[Server] Switching audio device to: ${deviceName} (${device})`);
  audioCapture.restart({ device, driver: finalDriver, name: deviceName });

  const payload = {
    device,
    deviceName,
    name: deviceName,
    driver: finalDriver
  };

  broadcastControlMessage({ type: 'device_changed', ...payload });
  broadcastControlMessage({ type: 'device_connected', ...payload });

  res.json({ success: true, ...payload });
});

// EasyEffects DSP Presets list endpoint
app.get('/api/dsp/presets', (req, res) => {
  res.json({
    currentPreset: audioCapture.dspPreset,
    activeFilterString: audioCapture.activeFilterString,
    presets: getDspPresetsList(audioCapture.dspPreset)
  });
});

// Set EasyEffects DSP Preset endpoint (protected)
app.post('/api/dsp/preset', authMiddleware, (req, res) => {
  const { preset, options } = req.body || {};
  if (!preset) {
    return res.status(400).json({ error: 'Missing preset parameter' });
  }

  if (!DSP_PRESETS[preset]) {
    return res.status(400).json({
      error: 'Invalid DSP preset',
      validPresets: Object.keys(DSP_PRESETS)
    });
  }

  audioCapture.setDspPreset(preset, options || {});
  res.json({
    success: true,
    preset: audioCapture.dspPreset,
    activeFilterString: audioCapture.activeFilterString,
    presets: getDspPresetsList(audioCapture.dspPreset)
  });
});

// -----------------------------------------------------------------------------
// 48-Hour Automatic Recording REST Endpoints
// -----------------------------------------------------------------------------

// List all recordings within the 48-hour retention window
app.get('/api/recordings', authMiddleware, (req, res) => {
  res.json(recordingManager.listRecordings());
});

// Middleware to authorize media playback via signed ticket, Bearer token, or token parameter
function recordingAuthMiddleware(req, res, next) {
  const secret = (process.env.AUTH_TOKEN || '').trim();
  if (!secret) return next();

  const safeFilename = path.basename(req.params.filename);
  if (req.query.ticket && isValidMediaTicket(req.query.ticket, safeFilename)) {
    return next();
  }

  return authMiddleware(req, res, next);
}

// Stream or download recording file (supports HTTP 206 Partial Content / Range header)
app.get('/api/recordings/:filename', recordingAuthMiddleware, (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  if (!safeFilename.startsWith('bandit_rec_') || (!safeFilename.endsWith('.mp3') && !safeFilename.endsWith('.wav'))) {
    return res.status(400).json({ error: 'Invalid recording filename' });
  }

  const rootDir = path.resolve(recordingManager.recordingsDir);
  const filePath = path.resolve(rootDir, safeFilename);
  if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
    return res.status(400).json({ error: 'Invalid recording path' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Recording file not found' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const contentType = safeFilename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }

    const chunkSize = (end - start) + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': req.query.download === '1' ? `attachment; filename="${safeFilename}"` : 'inline'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Manually delete a recording file
app.delete('/api/recordings/:filename', authMiddleware, (req, res) => {
  try {
    const deleted = recordingManager.deleteRecording(req.params.filename);
    if (deleted) {
      res.json({ success: true, filename: req.params.filename });
    } else {
      res.status(404).json({ error: 'Recording file not found' });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle or manually set auto-recording on/off
app.post('/api/recordings/toggle', authMiddleware, (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled === 'boolean') {
    recordingManager.setEnabled(enabled);
  } else {
    recordingManager.toggle();
  }

  const list = recordingManager.listRecordings();
  broadcastControlMessage({
    type: 'recording_status_changed',
    stats: list.stats
  });

  res.json({
    success: true,
    enabled: recordingManager.enabled,
    stats: list.stats
  });
});

// -----------------------------------------------------------------------------
// Audio Analysis & OpenAI Whisper STT Endpoints
// -----------------------------------------------------------------------------

// Get Whisper engine status and configuration
app.get('/api/analysis/config', authMiddleware, async (req, res) => {
  try {
    const status = await whisperAnalyzer.checkEngineStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Whisper configuration (API key or Base URL)
app.post('/api/analysis/config', authMiddleware, (req, res) => {
  const { openaiApiKey, whisperBaseUrl, model, maxSpeakers, minSegmentSec } = req.body || {};
  if (openaiApiKey !== undefined) whisperAnalyzer.openaiApiKey = String(openaiApiKey).trim();
  if (whisperBaseUrl !== undefined) whisperAnalyzer.whisperBaseUrl = String(whisperBaseUrl).trim();
  if (model !== undefined) whisperAnalyzer.model = model;
  if (maxSpeakers !== undefined) whisperAnalyzer.maxSpeakers = parseInt(maxSpeakers, 10);
  if (minSegmentSec !== undefined) whisperAnalyzer.minSegmentSec = parseFloat(minSegmentSec);
  res.json({ success: true, message: 'Whisper configuration updated' });
});

// Analyze on-demand last 30 seconds of live microphone stream
app.post('/api/analysis/live-snapshot', authMiddleware, async (req, res) => {
  try {
    const seconds = parseInt(req.body?.seconds || 30, 10);
    let recentBuffer = audioCapture.getRecentAudioBuffer(seconds);
    if (!recentBuffer || recentBuffer.length < 1000) {
      if (audioCapture.isRunning) {
        // Wait up to 1.5 seconds if capture supervisor is actively buffering startup chunks
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 100));
          recentBuffer = audioCapture.getRecentAudioBuffer(seconds);
          if (recentBuffer && recentBuffer.length >= 1000) break;
        }
      }
    }
    if (!recentBuffer || recentBuffer.length < 1000) {
      return res.status(400).json({ error: 'No audio captured in rolling buffer yet. Ensure microphone is active.' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `bandit_rec_snapshot_${timestamp}.mp3`;

    const report = await whisperAnalyzer.analyzeAudio(recentBuffer, {
      filename,
      sampleRate: audioCapture.sampleRate,
      channels: audioCapture.channels,
      language: req.body?.language,
      prompt: req.body?.prompt,
      keywords: req.body?.keywords,
      maxSpeakers: req.body?.maxSpeakers || whisperAnalyzer.maxSpeakers,
      minSegmentSec: req.body?.minSegmentSec || whisperAnalyzer.minSegmentSec
    });

    res.json({ success: true, report });
  } catch (err) {
    console.error('[Server] Live snapshot STT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Transcribe an existing 48-Hour Vault recording file
app.post('/api/analysis/transcribe', authMiddleware, async (req, res) => {
  try {
    const { filename, language, prompt, keywords, maxSpeakers, minSegmentSec } = req.body || {};
    if (!filename) {
      return res.status(400).json({ error: 'Missing filename parameter' });
    }

    const safeFilename = path.basename(filename);
    if (!safeFilename.startsWith('bandit_rec_') || (!safeFilename.endsWith('.mp3') && !safeFilename.endsWith('.wav'))) {
      return res.status(400).json({ error: 'Invalid recording filename' });
    }

    const rootDir = path.resolve(recordingManager.recordingsDir);
    const filePath = path.resolve(rootDir, safeFilename);
    if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
      return res.status(400).json({ error: 'Invalid recording path' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Recording file not found in vault' });
    }

    const report = await whisperAnalyzer.analyzeAudio(filePath, {
      filename: safeFilename,
      language,
      prompt,
      keywords,
      maxSpeakers: maxSpeakers || whisperAnalyzer.maxSpeakers,
      minSegmentSec: minSegmentSec || whisperAnalyzer.minSegmentSec
    });

    res.json({ success: true, report });
  } catch (err) {
    console.error('[Server] Transcribe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List all past analyzed transcripts
app.get('/api/analysis/jobs', authMiddleware, (req, res) => {
  try {
    const jobs = whisperAnalyzer.listTranscripts();
    res.json({ success: true, jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get a specific transcript by ID / filename
app.get('/api/analysis/jobs/:id', authMiddleware, (req, res) => {
  const report = whisperAnalyzer.getTranscript(req.params.id);
  if (!report) {
    return res.status(404).json({ error: 'Transcript report not found' });
  }
  res.json({ success: true, report });
});

// Export transcript in SRT, VTT, TXT, or JSON
app.get('/api/analysis/jobs/:id/export/:format', authMiddleware, (req, res) => {
  const report = whisperAnalyzer.getTranscript(req.params.id);
  if (!report) {
    return res.status(404).json({ error: 'Transcript report not found' });
  }

  const format = (req.params.format || 'txt').toLowerCase();
  const safeId = path.parse(report.filename || req.params.id).name;

  if (format === 'srt') {
    const srt = whisperAnalyzer.exportToSrt(report);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId}.srt"`);
    return res.send(srt);
  }

  if (format === 'vtt') {
    const vtt = whisperAnalyzer.exportToVtt(report);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId}.vtt"`);
    return res.send(vtt);
  }

  if (format === 'txt') {
    const txt = whisperAnalyzer.exportToTxt(report);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId}.txt"`);
    return res.send(txt);
  }

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId}.json"`);
    return res.json(report);
  }

  res.status(400).json({ error: 'Unsupported format. Choose srt, vtt, txt, or json.' });
});

// Delete a transcript from cache
app.delete('/api/analysis/jobs/:id', authMiddleware, (req, res) => {
  const deleted = whisperAnalyzer.deleteTranscript(req.params.id);
  if (deleted) {
    res.json({ success: true, id: req.params.id });
  } else {
    res.status(404).json({ error: 'Transcript report not found' });
  }
});

// -----------------------------------------------------------------------------
// WebSocket Stream Handling
// -----------------------------------------------------------------------------

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  if (parsedUrl.pathname !== '/stream') {
    socket.destroy();
    return;
  }

  const token = extractToken(req);
  const isAuth = !AUTH_TOKEN || isValidToken(token);

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isAuthenticated = isAuth;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;

  // If token is missing/invalid during upgrade, allow client one chance to send auth message
  if (!ws.isAuthenticated) {
    // Start auth challenge timeout (must authenticate within 5 seconds)
    const authTimeout = setTimeout(() => {
      if (!ws.isAuthenticated) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Authentication timed out' }));
        ws.close(4401, 'Unauthorized');
      }
    }, 5000);

    ws.on('message', (message, isBinary) => {
      if (isBinary) return;
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'auth') {
          if (isValidToken(data.token)) {
            clearTimeout(authTimeout);
            ws.isAuthenticated = true;
            onClientAuthenticated(ws);
          } else {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            ws.close(4401, 'Invalid token');
          }
        }
      } catch {
        // ignore malformed message
      }
    });

    // Send auth challenge
    ws.send(JSON.stringify({ type: 'auth_required', message: 'Authentication required' }));
    return;
  }

  onClientAuthenticated(ws);
});

function onClientAuthenticated(ws) {
  clients.add(ws);
  console.log(`[WebSocket] Client connected. Total active listeners: ${clients.size}`);

  // Cancel any scheduled on-demand stop timer
  if (onDemandStopTimeout) {
    clearTimeout(onDemandStopTimeout);
    onDemandStopTimeout = null;
  }

  // If on-demand capture, start capture when first client joins
  if (CAPTURE_MODE === 'on-demand' && !audioCapture.isRunning) {
    console.log('[Server] First listener connected. Starting on-demand audio capture...');
    audioCapture.start();
  }

  // Send handshake configuration
  ws.send(JSON.stringify({
    type: 'init',
    sampleRate: audioCapture.sampleRate,
    channels: audioCapture.channels,
    chunkMs: audioCapture.chunkMs,
    format: 'pcm_s16le',
    device: audioCapture.device,
    name: audioCapture.deviceName || getDeviceDisplayName(audioCapture.device),
    deviceName: audioCapture.deviceName || getDeviceDisplayName(audioCapture.device),
    driver: audioCapture.driver,
    devices: scanAudioDevices().map(d => ({ ...d, isActive: d.id === audioCapture.device })),
    dspPreset: audioCapture.dspPreset,
    activeFilterString: audioCapture.activeFilterString,
    dspPresets: getDspPresetsList(audioCapture.dspPreset),
    isSearching: audioCapture.isSearching,
    isFallback: audioCapture.isFallingBack,
    recording: recordingManager.listRecordings().stats,
    listeners: clients.size
  }));

  // Handle incoming client messages (ping, dsp preset, etc.)
  ws.on('message', (message, isBinary) => {
    if (isBinary) return;

    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'ping') {
        // Latency round-trip measurement response
        ws.send(JSON.stringify({
          type: 'pong',
          clientTime: data.clientTime,
          serverTime: Date.now()
        }));
      } else if (data.type === 'get_devices') {
        const rawDevices = scanAudioDevices();
        const currentDeviceName = audioCapture.deviceName || getDeviceDisplayName(audioCapture.device);
        const devices = rawDevices.map(d => ({
          ...d,
          isActive: d.id === audioCapture.device
        }));
        ws.send(JSON.stringify({
          type: 'devices_list',
          devices,
          currentDevice: audioCapture.device,
          currentDeviceName,
          currentDriver: audioCapture.driver
        }));
      } else if (data.type === 'switch_device' || data.type === 'set_device') {
        if (data.device) {
          const devices = scanAudioDevices();
          const matched = devices.find(d => d.id === data.device);
          const deviceName = matched ? matched.name : getDeviceDisplayName(data.device);
          const finalDriver = data.driver || (matched?.driver || 'auto');

          console.log(`[WebSocket] Switching audio device to: ${deviceName} (${data.device})`);
          audioCapture.restart({ device: data.device, driver: finalDriver, name: deviceName });

          const payload = {
            device: data.device,
            deviceName,
            name: deviceName,
            driver: finalDriver
          };
          broadcastControlMessage({ type: 'device_changed', ...payload });
          broadcastControlMessage({ type: 'device_connected', ...payload });
        }
      } else if (data.type === 'scan_devices') {
        const rawDevices = scanAudioDevices();
        const currentDeviceName = audioCapture.deviceName || getDeviceDisplayName(audioCapture.device);
        const devices = rawDevices.map(d => ({
          ...d,
          isActive: d.id === audioCapture.device
        }));
        broadcastControlMessage({
          type: 'devices_list',
          devices,
          currentDevice: audioCapture.device,
          currentDeviceName,
          currentDriver: audioCapture.driver
        });
      } else if (data.type === 'set_dsp_preset') {
        if (data.preset) {
          audioCapture.setDspPreset(data.preset, data.options || {});
        }
      } else if (data.type === 'get_recordings') {
        ws.send(JSON.stringify({
          type: 'recordings_list',
          data: recordingManager.listRecordings()
        }));
      } else if (data.type === 'toggle_recording') {
        if (typeof data.enabled === 'boolean') {
          recordingManager.setEnabled(data.enabled);
        } else {
          recordingManager.toggle();
        }
        broadcastControlMessage({
          type: 'recording_status_changed',
          stats: recordingManager.listRecordings().stats
        });
      } else if (data.type === 'set_recording_enabled') {
        recordingManager.setEnabled(Boolean(data.enabled));
        broadcastControlMessage({
          type: 'recording_status_changed',
          stats: recordingManager.listRecordings().stats
        });
      }
    } catch {
      // ignore
    }
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Total active listeners: ${clients.size}`);

    // If on-demand mode and no clients remain, stop capture after short grace period
    if (CAPTURE_MODE === 'on-demand' && clients.size === 0) {
      if (onDemandStopTimeout) clearTimeout(onDemandStopTimeout);
      onDemandStopTimeout = setTimeout(() => {
        if (clients.size === 0 && audioCapture.isRunning) {
          console.log('[Server] No active listeners. Stopping on-demand audio capture.');
          audioCapture.stop();
        }
      }, 5000);
    }
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Socket error:', err.message);
    clients.delete(ws);
  });
}

// Heartbeat ping interval to prune dead connections
const heartbeatInterval = setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) {
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }
}, 15000);

// -----------------------------------------------------------------------------
// Initialization & Graceful Shutdown
// -----------------------------------------------------------------------------

function startServer() {
  server.listen(PORT, HOST, () => {
    console.log('\n======================================================');
    console.log(`  BANDIT - Real-time Audio Surveillance Active`);
    console.log(`  HTTP/WS Server: http://${HOST}:${PORT}`);
    console.log(`  Auth Protected: ${Boolean(AUTH_TOKEN) ? 'YES (Token required)' : 'NO (Open access)'}`);
    console.log(`  Capture Mode:   ${CAPTURE_MODE}`);
    console.log(`  Target Device:  ${audioCapture.device}`);
    console.log('======================================================\n');

    if (CAPTURE_MODE === 'continuous') {
      audioCapture.start();
    }
  });
}

function shutdown() {
  console.log('\n[Bandit] Shutting down gracefully...');
  clearInterval(heartbeatInterval);
  recordingManager.stop();
  audioCapture.stop();
  for (const ws of clients) {
    try {
      ws.close(1001, 'Server shutting down');
    } catch {
      // ignore
    }
  }
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }
  server.close(() => {
    console.log('[Bandit] Server stopped.');
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(0);
  }, 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
