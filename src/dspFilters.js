/**
 * Bandit EasyEffects DSP Audio Engine
 * Real-time input sound processing presets & FFmpeg audio filter-graph builder.
 */

// EasyEffects-inspired surveillance presets
const DSP_PRESETS = {
  raw: {
    id: 'raw',
    name: 'Raw / Flat (Bypass)',
    description: 'Unprocessed bit-for-bit physical microphone audio without any filtering.',
    icon: '⚡',
    badge: 'BYPASS',
    features: {
      noiseGate: false,
      denoise: false,
      voiceEq: false,
      compression: false,
      speechNorm: false,
      limiter: false
    },
    buildFilter: () => null // No -af argument needed
  },

  whisper: {
    id: 'whisper',
    name: 'Whisper & Covert Surveillance',
    description: 'Ultra-sensitive sound enhancement. Amplifies faint distant whispers, speech frequencies, and room ambience with aggressive AGC and ear-protection limiting.',
    icon: '🕵️',
    badge: 'SURVEILLANCE',
    features: {
      noiseGate: false,
      denoise: true,
      voiceEq: true,
      compression: true,
      speechNorm: true,
      limiter: true
    },
    buildFilter: (opts = {}) => {
      const denoiseNf = Number.isFinite(parseFloat(opts.denoiseNf)) ? parseFloat(opts.denoiseNf) : -22;
      const boostGain = Number.isFinite(parseFloat(opts.boostGain)) ? parseFloat(opts.boostGain) : 4.5;
      return [
        'highpass=f=90',
        `afftdn=nf=${denoiseNf}`,
        `equalizer=f=3200:t=q:w=1.4:g=${boostGain}`,
        'equalizer=f=300:t=q:w=1.0:g=-2.5',
        'speechnorm=e=4.0:r=0.0001:l=1',
        'acompressor=threshold=-28dB:ratio=4:attack=10:release=120:makeup=6dB',
        'alimiter=limit=-1dB'
      ].join(',');
    }
  },

  broadcast: {
    id: 'broadcast',
    name: 'Clean Voice & Broadcast',
    description: 'Studio-quality speech clarity based on EasyEffects broadcast profiles. Noise gate, neural denoiser, vocal presence EQ, de-esser, and smooth radio leveling.',
    icon: '🎙️',
    badge: 'BROADCAST',
    features: {
      noiseGate: true,
      denoise: true,
      voiceEq: true,
      compression: true,
      speechNorm: false,
      limiter: true
    },
    buildFilter: (opts = {}) => {
      const gateThreshold = Number.isFinite(parseFloat(opts.gateThreshold)) ? parseFloat(opts.gateThreshold) : -34;
      const denoiseNf = Number.isFinite(parseFloat(opts.denoiseNf)) ? parseFloat(opts.denoiseNf) : -25;
      const presenceGain = Number.isFinite(parseFloat(opts.presenceGain)) ? parseFloat(opts.presenceGain) : 3.0;
      return [
        'highpass=f=80',
        `afftdn=nf=${denoiseNf}`,
        `agate=threshold=${gateThreshold}dB:ratio=2.5:attack=10:release=180:range=0.05`,
        'equalizer=f=280:t=q:w=1.2:g=-2.0',
        `equalizer=f=3500:t=q:w=1.5:g=${presenceGain}`,
        'deesser=i=0.4:m=0.5:f=0.5',
        'acompressor=threshold=-18dB:ratio=3:attack=15:release=100:makeup=2dB',
        'alimiter=limit=-0.8dB'
      ].join(',');
    }
  },

  noise_rejection: {
    id: 'noise_rejection',
    name: 'Extreme Noise Rejection',
    description: 'Maximum noise suppression for noisy server rooms, street traffic, or loud PC cooling fans. Strict noise gate with heavy spectral filtering.',
    icon: '🔇',
    badge: 'NOISE REDUCTION',
    features: {
      noiseGate: true,
      denoise: true,
      voiceEq: true,
      compression: false,
      speechNorm: false,
      limiter: true
    },
    buildFilter: (opts = {}) => {
      const gateThreshold = Number.isFinite(parseFloat(opts.gateThreshold)) ? parseFloat(opts.gateThreshold) : -26;
      const denoiseNf = Number.isFinite(parseFloat(opts.denoiseNf)) ? parseFloat(opts.denoiseNf) : -35;
      return [
        'highpass=f=120',
        `afftdn=nf=${denoiseNf}:tn=1`,
        `agate=threshold=${gateThreshold}dB:ratio=4:attack=5:release=120:range=0.01`,
        'equalizer=f=3000:t=q:w=1.8:g=4',
        'alimiter=limit=-1dB'
      ].join(',');
    }
  }
};

/**
 * Generate FFmpeg -af filter string for a given preset ID and optional overrides.
 */
function buildAudioFilterChain(presetId = 'broadcast', options = {}) {
  const preset = DSP_PRESETS[presetId] || DSP_PRESETS.raw;
  return preset.buildFilter(options);
}

/**
 * Get all available DSP presets metadata for API / UI clients.
 */
function getDspPresetsList(activePresetId = 'broadcast') {
  return Object.values(DSP_PRESETS).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    icon: p.icon,
    badge: p.badge,
    features: p.features,
    isActive: p.id === activePresetId
  }));
}

module.exports = {
  DSP_PRESETS,
  buildAudioFilterChain,
  getDspPresetsList
};
