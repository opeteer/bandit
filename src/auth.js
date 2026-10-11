/**
 * Bandit Authentication Module
 * Supports token / password authentication with timing-safe comparison.
 */

const crypto = require('crypto');

/**
 * Compare two strings in constant time to prevent timing and length attacks.
 * Hashing both values to 32-byte SHA-256 digests ensures equal length comparison.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Validates a given token against the configured AUTH_TOKEN.
 * Returns true if auth is disabled (AUTH_TOKEN is empty) or if token matches.
 */
function isValidToken(providedToken, expectedToken = process.env.AUTH_TOKEN) {
  const secret = (expectedToken || '').trim();
  if (!secret) {
    // Authentication disabled
    return true;
  }
  if (!providedToken) {
    return false;
  }
  return safeCompare(providedToken.trim(), secret);
}

/**
 * Extracts authentication token from an HTTP request or WebSocket handshake.
 */
function extractToken(req) {
  // 1. Check Bearer Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  // 2. Check X-Bandit-Token or X-Auth-Token header
  const customHeader = req.headers['x-bandit-token'] || req.headers['x-auth-token'];
  if (customHeader) {
    return String(customHeader).trim();
  }

  // 3. Check query parameter ?token=...
  if (req.url) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const queryToken = parsedUrl.searchParams.get('token');
      if (queryToken) return queryToken.trim();
    } catch {
      // Fallback simple regex
      const match = req.url.match(/[?&]token=([^&]+)/);
      if (match) return decodeURIComponent(match[1]).trim();
    }
  }

  // 4. Check Sec-WebSocket-Protocol header (common fallback for browser WS token passing)
  const protocols = req.headers['sec-websocket-protocol'];
  if (protocols) {
    const parts = protocols.split(',').map(s => s.trim());
    for (const part of parts) {
      if (part.startsWith('token.')) {
        return part.slice(6);
      }
    }
  }

  return null;
}

/**
 * Express middleware for protecting REST endpoints.
 */
function authMiddleware(req, res, next) {
  const secret = (process.env.AUTH_TOKEN || '').trim();
  if (!secret) {
    return next();
  }

  const token = extractToken(req);
  if (isValidToken(token, secret)) {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid authentication token required'
  });
}

/**
 * Generate a short-lived HMAC-SHA256 signed ticket for media streaming.
 * Valid for expiresInSeconds (default 120s).
 */
function generateMediaTicket(filename = '*', expiresInSeconds = 120) {
  const secret = (process.env.AUTH_TOKEN || 'bandit-media-key').trim();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${expiresAt}:${filename}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

/**
 * Validate a media ticket for a requested file.
 */
function isValidMediaTicket(ticket, filename) {
  const secret = (process.env.AUTH_TOKEN || '').trim();
  if (!secret) return true; // Auth disabled
  if (!ticket || typeof ticket !== 'string') return false;

  try {
    const raw = Buffer.from(ticket, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 3) return false;
    const sig = parts.pop();
    const expiresAtStr = parts.shift();
    const ticketFilename = parts.join(':');
    const expiresAt = parseInt(expiresAtStr, 10);
    if (isNaN(expiresAt) || Math.floor(Date.now() / 1000) > expiresAt) {
      return false; // Expired
    }
    if (ticketFilename !== '*' && ticketFilename !== filename) {
      return false; // File mismatch
    }

    const payload = `${expiresAt}:${ticketFilename}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return safeCompare(sig, expectedSig);
  } catch {
    return false;
  }
}

module.exports = {
  isValidToken,
  extractToken,
  authMiddleware,
  safeCompare,
  generateMediaTicket,
  isValidMediaTicket
};
