# 🦝 BANDIT - Real-Time Host Audio Surveillance

> Lightweight, self-hosted web surveillance application that captures the host PC's physical microphone and streams live audio to authenticated web clients with ultra-low latency (< 100ms).

---

## ✨ Features

- **Ultra-Low Latency Pipeline**: Streams raw 16-bit PCM audio over WebSockets directly into browser `AudioContext` buffers. Employs drift compensation and jitter-buffer scheduling to guarantee sub-100ms latency without audio buildup or lag.
- **Cross-Platform Microphone Ingestion & Auto-Discovery**: Piped FFmpeg capture supporting **Linux** (ALSA / PulseAudio / PipeWire), **Windows** (DirectShow), and **macOS** (AVFoundation). **Continuously polls the host in the background if no microphone is found** and seamlessly auto-connects to newly plugged-in physical devices on the fly without restarting!
- **EasyEffects DSP Sound Rack**: Real-time input sound processing modeled after Linux EasyEffects technology: Neural Noise Suppression, Downward Noise Gate, Vocal Presence Parametric EQ, Broadcast Dynamic Compressor, De-Esser, Speech Normalization, and Lookahead Peak Limiter.
- **Surveillance Presets**: Instant 1-click sound profiles: **Whisper & Covert Surveillance** (high sensitivity AGC), **Clean Voice & Broadcast**, **Extreme Noise Rejection**, and **Raw Bypass**.
- **Microphone Amplification**: Built-in 1.0x – 5.0x Gain Boost slider to amplify faint room whispers and distant ambient audio.
- **Live Canvas Visualizer & VU Meter**: Dual-mode 60fps real-time visualizer (Oscilloscope Waveform & Frequency Spectrum Bars) powered by `AnalyserNode`, along with an active dB VU meter and sound-detection LED indicator.
- **Access Security**: Constant-time timing-safe token authentication protecting REST endpoints and WebSocket handshakes—ideal for zero-trust exposure via Cloudflare Tunnel, Tailscale, or ngrok.
- **Real-Time Telemetry**: Live round-trip latency counter, stream buffer health (ms), data throughput (KB/s), total payload received, and active listener count.
- **Docker Compose Ready**: One-command containerized deployment with direct `/dev/snd` host microphone passthrough.
- **Zero Heavy Frontend Frameworks**: Built entirely with modern vanilla HTML5, CSS3, and JavaScript.

---

## 📂 Project Directory Structure

```text
bandit/
├── .dockerignore              # Container build ignore rules
├── .env.example               # Template environment configuration
├── .gitignore                 # Git ignore rules
├── Dockerfile                 # Debian-slim Node.js + FFmpeg container image
├── docker-compose.yml         # Container compose definition with host ALSA passthrough
├── package.json               # Node.js dependencies and run scripts
├── README.md                  # Comprehensive setup and operations manual
├── server.js                  # Main Express + WebSocket server & stream coordinator
├── src/
│   ├── audioCapture.js        # FFmpeg process supervisor with auto-restart & fallback
│   ├── auth.js                # Timing-safe token authentication & middleware
│   ├── deviceScanner.js       # Cross-platform audio device enumeration CLI & API
│   └── dspFilters.js          # EasyEffects-inspired real-time DSP sound rack & filter chains
├── test/
│   ├── verify.js              # Full system and WebSocket test suite
│   ├── verify_search.js       # Continuous mic search & auto-connect test
│   └── verify_dsp.js          # EasyEffects DSP filter chain & live stream test
└── public/
    ├── index.html             # Surveillance dashboard layout & UI controls
    ├── style.css              # Cyber-tactical responsive dark theme
    └── app.js                 # Web Audio API engine, drift buffer, & canvas visualizer
```

---

## 🚀 Quick Start (Docker Compose)

The easiest way to run Bandit on Linux hosts is with Docker Compose:

### 1. Clone & Configure
```bash
cp .env.example .env
```
Edit `.env` and set your desired `AUTH_TOKEN` and `AUDIO_DEVICE` (e.g. `default` or `hw:1,0`).

### 2. Start with Docker Compose
```bash
docker compose up -d
```

### 3. Open Dashboard
Open your web browser at:
```
http://localhost:8080
```
Enter your `AUTH_TOKEN` when prompted and click **"Start Listening"**.

To view live container logs:
```bash
docker compose logs -f
```

To stop:
```bash
docker compose down
```

---

## 💻 Native Host Installation (Node.js)

### Prerequisites
- **Node.js**: v18+ or v20+ / v22+
- **FFmpeg**: Must be installed and accessible in your system `PATH`.
  - **Ubuntu / Debian**: `sudo apt install ffmpeg alsa-utils`
  - **Fedora / RHEL**: `sudo dnf install ffmpeg alsa-utils`
  - **Arch Linux**: `sudo pacman -S ffmpeg alsa-utils`
  - **macOS**: `brew install ffmpeg`
  - **Windows**: `winget install Gyan.FFmpeg` or `choco install ffmpeg`

### Installation Steps

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Discover Audio Capture Devices**:
   Run the included cross-platform device scanner to find your microphone's identifier:
   ```bash
   npm run list-devices
   ```

3. **Configure Environment**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Set `AUDIO_DEVICE` to one of the IDs discovered in step 2 (e.g., `hw:1,0`, `default`, or `test`).

4. **Start Server**:
   ```bash
   npm start
   ```

---

## 🎙️ Step-by-Step Audio Device Identification

Bandit can capture any microphone connected to your computer. Here is how to find the exact device identifier on each operating system:

### Built-in Discovery Utility
Run Bandit's built-in scanner:
```bash
npm run list-devices
```
This utility automatically probes your OS and outputs a numbered list of available hardware and virtual capture devices along with sample `.env` configurations.

---

### Manual Identification by Platform

#### 🐧 Linux (ALSA / PulseAudio / PipeWire)
- **ALSA Hardware Cards**:
  ```bash
  arecord -l
  ```
  *Example Output:*
  ```text
  **** List of CAPTURE Hardware Devices ****
  card 1: PCH [HDA Intel PCH], device 0: ALC257 Analog [ALC257 Analog]
  ```
  Set in `.env`:
  ```ini
  AUDIO_DRIVER=alsa
  AUDIO_DEVICE=hw:1,0
  ```
- **ALSA Default / PipeWire Output**:
  ```ini
  AUDIO_DRIVER=alsa
  AUDIO_DEVICE=default
  ```
- **PulseAudio Sources**:
  ```bash
  pactl list sources short
  ```
  Set in `.env`:
  ```ini
  AUDIO_DRIVER=pulse
  AUDIO_DEVICE=alsa_input.pci-0000_00_1f.3.analog-stereo
  ```

#### 🪟 Windows (DirectShow)
List all DirectShow audio devices registered with FFmpeg:
```cmd
ffmpeg -list_devices true -f dshow -i dummy
```
*Example Output:*
```text
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  "Microphone Array (Realtek Audio)"
```
Set in `.env`:
```ini
AUDIO_DRIVER=dshow
AUDIO_DEVICE=audio="Microphone Array (Realtek Audio)"
```

#### 🍎 macOS (AVFoundation)
List AVFoundation input devices:
```bash
ffmpeg -f avfoundation -list_devices true -i ""
```
*Example Output:*
```text
[AVFoundation indev @ 0x7fa2] AVFoundation audio devices:
[AVFoundation indev @ 0x7fa2] [0] Built-in Microphone
```
Set in `.env`:
```ini
AUDIO_DRIVER=avfoundation
AUDIO_DEVICE=:0
```

#### 🧪 Synthetic Test Mode (No Hardware Mic Needed)
If you are developing in a headless server, CI pipeline, or VM without a physical microphone, set:
```ini
AUDIO_DEVICE=test
```
Bandit will synthesize a 440 Hz reference tone with periodic pulses for testing the entire streaming and visualizer pipeline.

---

## 🎛️ EasyEffects Real-Time DSP Audio Processing Rack

Bandit integrates an embedded audio processing engine modeled after the core technologies of Linux's **EasyEffects** (formerly PulseEffects). It applies real-time DSP filter-graphs at sub-5ms processing latency directly in the capture pipeline:

| DSP Module | Underlying Tech | Purpose in Surveillance |
| :--- | :--- | :--- |
| **High-Pass (Low-Cut)** | Butterworth 80-120Hz | Cuts table bumps, desk handling, wind gusts, and 50/60Hz AC hum. |
| **Neural Denoise** | `librnnoise` / `afftdn` | Suppresses constant background noise (PC fans, traffic, air conditioning). |
| **Downward Noise Gate** | LSP Gate (`agate`) | Completely silences the stream when nobody is talking; stops line hiss. |
| **Parametric Voice EQ** | LSP Parametric EQ | 3.2 kHz presence boost for consonant clarity + 280 Hz boxiness cut. |
| **Broadcast Compressor** | LSP Compressor | Levels dynamic range: amplifies quiet whispers, pulls down loud peaks. |
| **Speech De-Esser** | Calf / LSP De-Esser | Tames piercing sibilant frequencies ("s", "sh", "ch") to protect ears. |
| **Peak Lookahead Limiter** | LSP Limiter | Zero-overshoot brickwall ceiling (-1.0 dBFS) to prevent clipping distortion. |

### Available Presets
1. **`broadcast` (Clean Voice & Broadcast)**: Default profile. Full noise gate, spectral denoiser, vocal presence boost, and radio leveling.
2. **`whisper` (Whisper & Covert Surveillance)**: Extreme sensitivity. High AGC expansion (4x), speech presence boost, and dynamic compression to capture faint distant speech.
3. **`noise_rejection` (Extreme Noise Rejection)**: High-noise environments (server rooms, loud street noise, cooling fans). Steep low-cut filter with strict -26 dB noise gate.
4. **`raw` (Raw / Flat Bypass)**: Bit-for-bit uncolored physical audio capture without any filtering.

Presets can be switched in real time from the **web dashboard**, via REST API (`POST /api/dsp/preset`), or over WebSockets (`{"type": "set_dsp_preset", "preset": "whisper"}`).

---

## 📼 48-Hour Automatic Recording System & Rolling Vault

Bandit features an autonomous 24/7 rolling surveillance recording system:
- **Maximum 1-Hour Segments**: Live microphone audio is continuously encoded into standardized segments (`bandit_rec_YYYY-MM-DD_HH-mm-ss.mp3`). Once an audio file reaches **1 hour (3600 seconds)**, it is cleanly finalized and saved, and a new segment starts instantly without dropped frames.
- **Rolling 48-Hour Retention**: Any saved recording older than **48 hours** is automatically deleted from the host storage. The pruning engine checks every 5 minutes and immediately upon segment rotation.
- **High Efficiency & Low Storage Footprint**: Uses `libmp3lame` (64 kbps mono CBR) by default:
  - **1 Hour File**: ~28.8 MB
  - **Full 48-Hour Archive**: ~1.38 GB total storage
  - Can be switched to uncompressed PCM WAV via `RECORDING_FORMAT=wav`.
- **Integrated Web Vault & Browser Player**:
  - Live 🔴 REC indicator and segment progress bar (`00:14:22 / 01:00:00`).
  - Storage telemetry showing active items, total archive disk usage, and retention age.
  - Interactive table with **Seekable In-Browser Playback** (via HTTP 206 Partial Content range requests), **Download**, and **Manual Deletion**.
  - One-click pause/resume recording toggle.

### Recording REST API Endpoints
- `GET /api/recordings`: Enumerate all recordings within the 48-hour retention window with storage stats.
- `GET /api/recordings/:filename`: Stream audio file with HTTP 206 Partial Content / Range header support (or download with `?download=1`).
- `DELETE /api/recordings/:filename`: Manually delete a recording item.
- `POST /api/recordings/toggle`: Pause or resume automatic recording.

---

## ⚙️ Configuration Reference (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | Port for HTTP server and WebSocket stream. |
| `HOST` | `0.0.0.0` | Host bind address (`0.0.0.0` for network-wide access). |
| `AUTH_TOKEN` | `""` | Secret password/token. If set, clients must authenticate. If empty, stream is public. |
| `AUDIO_DEVICE` | `auto` | Input device identifier (`auto`, `default`, `hw:0,0`, `audio="..."`, or `test`). |
| `AUDIO_DRIVER` | `auto` | Driver mode: `auto`, `alsa`, `pulse`, `dshow`, `avfoundation`, or `lavfi`. |
| `DSP_PRESET` | `broadcast` | Active EasyEffects sound profile (`broadcast`, `whisper`, `noise_rejection`, `raw`). |
| `SAMPLE_RATE` | `24000` | Sample rate in Hz (`16000`, `24000`, `48000`). `24000` is optimal for voice clarity and low bandwidth (48 KB/s). |
| `CHANNELS` | `1` | `1` for mono (recommended for microphones), `2` for stereo. |
| `CHUNK_MS` | `40` | Buffer packet interval in milliseconds (30ms – 50ms recommended for ultra-low latency). |
| `CAPTURE_MODE` | `continuous` | `continuous`: Keep capturing at all times. `on-demand`: Start capture only when $\ge 1$ listener connects. |
| `AUTO_SEARCH_MIC` | `true` | Continuously search host PC for a microphone when none is detected, and auto-connect when plugged in. |
| `MIC_SEARCH_INTERVAL` | `3000` | Search polling interval in milliseconds (default: `3000ms` / 3 seconds). |
| `AUTO_RECORDING_ENABLED` | `true` | Enable 24/7 background audio recording into the rolling vault. |
| `RECORDING_SEGMENT_SECONDS` | `3600` | Maximum recording length per file before saving (default: `3600` / 1 hour). |
| `RECORDING_RETENTION_HOURS` | `48` | Rolling retention period in hours. Files older than this are automatically deleted. |
| `RECORDINGS_DIR` | `./recordings` | Directory path where recording segments are stored. |
| `RECORDING_FORMAT` | `mp3` | Encoding format (`mp3` or `wav`). |
| `RECORDING_BITRATE` | `64k` | MP3 bitrate (default: `64k` mono voice). |

---

## 🌐 Secure Remote Exposure (Tunnels)

When accessing Bandit remotely over the internet, keep `AUTH_TOKEN` enabled and pair it with an encrypted tunnel:

### 1. Cloudflare Tunnel (Recommended)
1. Install `cloudflared`:
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
2. Cloudflare will assign a secure HTTPS/WSS URL (e.g., `https://random-subdomain.trycloudflare.com`).
3. Connect from any remote mobile phone or laptop. WebSockets and audio streaming pass through seamlessly.

### 2. Tailscale
1. Install Tailscale on the host machine:
   ```bash
   tailscale up
   ```
2. Enable Tailscale Funnel or access directly via your Tailscale IP:
   ```bash
   tailscale funnel 8080
   ```
3. Access privately across your personal mesh network without opening firewall ports.

---

## 🔒 Security Architecture

- **Timing-Safe Authentication**: Authenticates clients using Node.js `crypto.timingSafeEqual` to eliminate timing side-channel attacks.
- **WebSocket Handshake Validation**: Inspects incoming WebSocket upgrade requests using token query parameters, Bearer tokens, or custom headers before completing connection upgrade.
- **Backpressure Protection**: Prevents network buffer accumulation. If a client's network lags, frames are safely dropped to maintain real-time synchronicity rather than causing delayed playback.

---

## 🛠️ Verification & Troubleshooting

### Test the API
```bash
# Check system status
curl -s http://localhost:8080/api/status | jq .

# Check devices (with token)
curl -s "http://localhost:8080/api/devices?token=your-token" | jq .
```

### Browser Autoplay Notice
Modern web browsers (Chrome, Firefox, Safari, Edge) block audio playback without prior user interaction. When opening the dashboard for the first time, click the **"START LISTENING"** button to grant Web Audio API playback permissions.

### Linux Device Busy (`Device or resource busy`)
If FFmpeg reports that `hw:1,0` is busy, another service (e.g. PulseAudio or PipeWire) has an exclusive ALSA lock on the card.
Change your `.env` to use the shared device:
```ini
AUDIO_DEVICE=default
```
or
```ini
AUDIO_DRIVER=pulse
AUDIO_DEVICE=default
```

---

## 📄 License
MIT License. Built for self-hosted audio monitoring and diagnostics.
