/**
 * Bandit 48-Hour Automatic Recording System
 * - Automatically records live audio in maximum 1-hour segments.
 * - Rolling 48-hour retention cycle: automatically deletes recordings older than 48 hours.
 * - Provides file streaming, metadata enumeration, and disk management.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

class RecordingManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Storage configuration
    this.recordingsDir = options.recordingsDir || process.env.RECORDINGS_DIR || path.join(__dirname, '..', 'recordings');
    this.enabled = options.enabled !== undefined ? options.enabled : (process.env.AUTO_RECORDING_ENABLED !== 'false');
    this.segmentDurationSeconds = parseInt(options.segmentDurationSeconds || process.env.RECORDING_SEGMENT_SECONDS || '3600', 10); // 1 hour max
    this.retentionHours = parseFloat(options.retentionHours || process.env.RECORDING_RETENTION_HOURS || '48'); // 48 hours
    this.format = (options.format || process.env.RECORDING_FORMAT || 'mp3').toLowerCase(); // 'mp3' or 'wav'
    this.bitrate = options.bitrate || process.env.RECORDING_BITRATE || '64k';

    // Audio stream settings (received from AudioCapture)
    this.sampleRate = parseInt(options.sampleRate || process.env.SAMPLE_RATE || '24000', 10);
    this.channels = parseInt(options.channels || process.env.CHANNELS || '1', 10);
    this.bytesPerSample = 2; // 16-bit PCM

    // Active segment state
    this.currentProcess = null;
    this.currentFile = null;
    this.currentFilePath = null;
    this.segmentStartTime = null;
    this.bytesWrittenCurrentSegment = 0;
    this.isRotating = false;

    // Pruning scheduler
    this.cleanupTimer = null;
    this.cleanupIntervalMs = 5 * 60 * 1000; // Check every 5 minutes

    // Ensure storage directory exists
    if (!fs.existsSync(this.recordingsDir)) {
      try {
        fs.mkdirSync(this.recordingsDir, { recursive: true });
      } catch (err) {
        console.error('[RecordingManager] Failed to create recordings directory:', err.message);
      }
    }

    // Start background cleanup schedule
    this.startCleanupScheduler();
  }

  /**
   * Start a new recording segment file.
   */
  startNewSegment() {
    if (this.currentProcess) {
      this.finalizeCurrentSegment();
    }

    const timestamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}_${pad(timestamp.getHours())}-${pad(timestamp.getMinutes())}-${pad(timestamp.getSeconds())}`;
    let filename = `bandit_rec_${dateStr}.${this.format}`;
    let filePath = path.join(this.recordingsDir, filename);

    // Handle collision if toggled multiple times within the same second
    let counter = 1;
    while (fs.existsSync(filePath)) {
      filename = `bandit_rec_${dateStr}_${counter}.${this.format}`;
      filePath = path.join(this.recordingsDir, filename);
      counter++;
    }

    this.currentFile = filename;
    this.currentFilePath = filePath;
    this.segmentStartTime = Date.now();
    this.bytesWrittenCurrentSegment = 0;
    this.isRotating = false;

    // Build FFmpeg encoder arguments
    const encoderArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 's16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      '-i', 'pipe:0'
    ];

    if (this.format === 'mp3') {
      encoderArgs.push('-c:a', 'libmp3lame', '-b:a', this.bitrate);
    } else {
      // standard WAV PCM
      encoderArgs.push('-c:a', 'pcm_s16le');
    }

    encoderArgs.push(filePath);

    try {
      this.currentProcess = spawn('ffmpeg', encoderArgs, {
        stdio: ['pipe', 'ignore', 'pipe']
      });

      this.currentProcess.stderr.on('data', (data) => {
        console.error(`[RecordingManager FFmpeg stderr]: ${data.toString().trim()}`);
      });

      this.currentProcess.on('close', (code) => {
        if (code !== 0 && code !== null) {
          console.warn(`[RecordingManager] Segment encoder process closed with code ${code}`);
        }
      });

      console.log(`[RecordingManager] 🔴 Started new recording segment: "${filename}" (Max duration: ${this.segmentDurationSeconds / 60}m)`);
      this.emit('segment_started', {
        filename,
        startTime: this.segmentStartTime,
        maxDurationSeconds: this.segmentDurationSeconds
      });

    } catch (err) {
      console.error('[RecordingManager] Failed to spawn recording encoder:', err.message);
      this.currentProcess = null;
    }
  }

  /**
   * Finalize and close the current recording segment cleanly.
   */
  finalizeCurrentSegment() {
    if (!this.currentProcess) return;

    const finishedFile = this.currentFile;
    const proc = this.currentProcess;
    this.currentProcess = null;
    this.currentFile = null;
    this.currentFilePath = null;

    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
    } catch {
      // ignore
    }

    const durationSeconds = this.segmentStartTime ? Math.round((Date.now() - this.segmentStartTime) / 1000) : 0;
    this.segmentStartTime = null;
    console.log(`[RecordingManager] 💾 Saved recording segment: "${finishedFile}" (Duration: ${durationSeconds}s)`);

    this.emit('segment_saved', {
      filename: finishedFile,
      durationSeconds,
      savedAt: new Date().toISOString()
    });

    // Run 48-hour purge check after segment finalization
    this.purgeExpiredRecordings();
  }

  /**
   * Set recording enabled state explicitly (turn ON or OFF manually).
   */
  setEnabled(enabled) {
    const newState = Boolean(enabled);
    if (this.enabled === newState) {
      return this.enabled;
    }

    this.enabled = newState;
    console.log(`[RecordingManager] 🔄 Auto-recording manually ${this.enabled ? 'TURNED ON (ACTIVE)' : 'TURNED OFF (PAUSED)'}`);

    if (!this.enabled && this.currentProcess) {
      // Cleanly finalize active segment so far
      this.finalizeCurrentSegment();
    }

    this.emit('status_changed', {
      enabled: this.enabled,
      isRecording: this.enabled && Boolean(this.currentProcess),
      stats: this.listRecordings().stats
    });

    return this.enabled;
  }

  enable() {
    return this.setEnabled(true);
  }

  disable() {
    return this.setEnabled(false);
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  /**
   * Feed raw PCM chunk from AudioCapture into current recording segment.
   */
  writeChunk(chunk) {
    if (!this.enabled || !chunk || chunk.length === 0) return;

    if (!this.currentProcess) {
      this.startNewSegment();
    }

    if (!this.currentProcess || !this.currentProcess.stdin || this.currentProcess.stdin.destroyed) {
      return;
    }

    try {
      this.currentProcess.stdin.write(chunk);
      this.bytesWrittenCurrentSegment += chunk.length;

      // Check if current segment reached max duration (e.g. 1 hour / 3600 seconds)
      const elapsedSeconds = (Date.now() - this.segmentStartTime) / 1000;
      if (elapsedSeconds >= this.segmentDurationSeconds && !this.isRotating) {
        this.isRotating = true;
        console.log(`[RecordingManager] Segment limit reached (${this.segmentDurationSeconds}s). Seamlessly rotating to next hour...`);
        this.startNewSegment();
      }
    } catch (err) {
      console.error('[RecordingManager] Write chunk error:', err.message);
    }
  }

  /**
   * Scan and delete recordings older than the retention period (48 hours).
   */
  purgeExpiredRecordings() {
    if (!fs.existsSync(this.recordingsDir)) return [];

    const now = Date.now();
    const retentionMs = this.retentionHours * 60 * 60 * 1000;
    const deletedFiles = [];

    try {
      const files = fs.readdirSync(this.recordingsDir);
      for (const file of files) {
        if (!file.startsWith('bandit_rec_') || (!file.endsWith('.mp3') && !file.endsWith('.wav'))) {
          continue;
        }

        // Skip currently active recording file!
        if (file === this.currentFile) {
          continue;
        }

        const filePath = path.join(this.recordingsDir, file);
        try {
          const stats = fs.statSync(filePath);
          const ageMs = now - stats.mtimeMs;

          if (ageMs > retentionMs) {
            fs.unlinkSync(filePath);
            deletedFiles.push(file);
            console.log(`[RecordingManager] 🗑️ Auto-deleted expired recording (> ${this.retentionHours}h): ${file} (Age: ${(ageMs / (3600000)).toFixed(1)}h)`);

            // Also clean up associated transcript file in transcripts/
            const baseId = path.parse(file).name;
            const transcriptPath = path.join(this.recordingsDir, 'transcripts', `${baseId}.json`);
            if (fs.existsSync(transcriptPath)) {
              try {
                fs.unlinkSync(transcriptPath);
                console.log(`[RecordingManager] 🗑️ Auto-deleted associated transcript: ${baseId}.json`);
              } catch {}
            }
          }
        } catch {
          // ignore individual file errors
        }
      }

      if (deletedFiles.length > 0) {
        this.emit('recordings_purged', { deletedFiles, count: deletedFiles.length });
      }
    } catch (err) {
      console.error('[RecordingManager] Error during expired recordings purge:', err.message);
    }

    return deletedFiles;
  }

  /**
   * Periodic scheduler to purge files older than 48 hours.
   */
  startCleanupScheduler() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    // Initial check on boot
    setTimeout(() => this.purgeExpiredRecordings(), 2000);
    // Recurring check
    this.cleanupTimer = setInterval(() => {
      this.purgeExpiredRecordings();
    }, this.cleanupIntervalMs);
  }

  /**
   * Stop recording engine cleanly.
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.finalizeCurrentSegment();
  }

  /**
   * Get metadata list of all active recordings stored within the 48-hour cycle.
   */
  listRecordings() {
    if (!fs.existsSync(this.recordingsDir)) {
      return { recordings: [], stats: { totalFiles: 0, totalSizeBytes: 0 } };
    }

    const now = Date.now();
    const recordings = [];
    let totalSizeBytes = 0;

    try {
      const files = fs.readdirSync(this.recordingsDir);
      for (const file of files) {
        if (!file.startsWith('bandit_rec_') || (!file.endsWith('.mp3') && !file.endsWith('.wav'))) {
          continue;
        }

        const filePath = path.join(this.recordingsDir, file);
        try {
          const stat = fs.statSync(filePath);
          const ageHours = (now - stat.mtimeMs) / 3600000;
          totalSizeBytes += stat.size;

          recordings.push({
            filename: file,
            sizeBytes: stat.size,
            sizeFormatted: this.formatBytes(stat.size),
            createdAt: stat.birthtime || stat.mtime,
            modifiedAt: stat.mtime,
            ageHours: parseFloat(ageHours.toFixed(1)),
            isCurrent: Boolean(this.currentProcess) && file === this.currentFile,
            downloadUrl: `/api/recordings/${encodeURIComponent(file)}`
          });
        } catch {
          // ignore
        }
      }

      // Sort newest first
      recordings.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    } catch (err) {
      console.error('[RecordingManager] Error listing recordings:', err.message);
    }

    return {
      recordings,
      stats: {
        totalFiles: recordings.length,
        totalSizeBytes,
        totalSizeFormatted: this.formatBytes(totalSizeBytes),
        retentionHours: this.retentionHours,
        segmentDurationSeconds: this.segmentDurationSeconds,
        enabled: this.enabled,
        isRecording: this.enabled && Boolean(this.currentProcess),
        currentSegment: (this.enabled && this.currentFile && this.currentProcess) ? {
          filename: this.currentFile,
          elapsedSeconds: this.segmentStartTime ? Math.round((Date.now() - this.segmentStartTime) / 1000) : 0,
          maxSeconds: this.segmentDurationSeconds
        } : null
      }
    };
  }

  /**
   * Manually delete a recording file.
   */
  deleteRecording(filename) {
    if (!filename || typeof filename !== 'string') return false;
    // Sanitize filename to prevent directory traversal
    const safeName = path.basename(filename);
    if (!safeName.startsWith('bandit_rec_') || (!safeName.endsWith('.mp3') && !safeName.endsWith('.wav'))) {
      throw new Error('Invalid recording filename');
    }

    if (safeName === this.currentFile) {
      throw new Error('Cannot delete currently recording active segment');
    }

    const rootDir = path.resolve(this.recordingsDir);
    const targetPath = path.resolve(rootDir, safeName);
    if (!targetPath.startsWith(rootDir + path.sep) && targetPath !== rootDir) {
      throw new Error('Access denied: Invalid recording path');
    }

    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
      console.log(`[RecordingManager] Deleted recording: ${safeName}`);

      // Also clean up associated transcript file in transcripts/
      const baseId = path.parse(safeName).name;
      const transcriptPath = path.join(this.recordingsDir, 'transcripts', `${baseId}.json`);
      if (fs.existsSync(transcriptPath)) {
        try {
          fs.unlinkSync(transcriptPath);
          console.log(`[RecordingManager] Deleted associated transcript: ${baseId}.json`);
        } catch {}
      }
      return true;
    }
    return false;
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = RecordingManager;
