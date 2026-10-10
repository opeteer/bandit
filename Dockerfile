# ==============================================================================
# Bandit Dockerfile
# Lightweight container image for real-time host audio surveillance
# ==============================================================================

FROM node:22-bookworm-slim

# Install FFmpeg, ALSA utilities and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    alsa-utils \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application sources
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Default environment configurations
ENV PORT=8099 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    AUDIO_DEVICE=default \
    AUDIO_DRIVER=alsa \
    SAMPLE_RATE=24000 \
    CHANNELS=1 \
    CHUNK_MS=40 \
    CAPTURE_MODE=continuous

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8099/api/status || exit 1

CMD ["node", "server.js"]
