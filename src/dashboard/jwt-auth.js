const crypto = require('node:crypto');

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function verifyHs256Jwt(token, secret, expectedIssuer) {
  if (!token || typeof token !== 'string') {
    return { valid: false, code: 'UNAUTHORIZED', message: 'Missing Bearer token' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, code: 'UNAUTHORIZED', message: 'Malformed JWT' };
  }

  const [encodedHeader, encodedPayload, encodedSig] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader));
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { valid: false, code: 'UNAUTHORIZED', message: 'Invalid JWT encoding' };
  }

  if (header.alg !== 'HS256') {
    return { valid: false, code: 'UNAUTHORIZED', message: 'Unsupported JWT algorithm' };
  }

  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest()
  );

  const actualBuf = Buffer.from(encodedSig);
  const expectedBuf = Buffer.from(expectedSig);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return { valid: false, code: 'UNAUTHORIZED', message: 'Invalid JWT signature' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    return { valid: false, code: 'UNAUTHORIZED', message: 'JWT expired or missing exp claim' };
  }

  if (expectedIssuer && payload.iss !== expectedIssuer) {
    return { valid: false, code: 'FORBIDDEN', message: 'Invalid JWT issuer' };
  }

  return { valid: true, payload };
}

function createJwtAuthMiddleware({ secret, issuer }) {
  return (req, res, next) => {
    if (!secret) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'DASHBOARD_JWT_SECRET is not configured on Dashboard Backend',
        },
      });
    }

    const authHeader = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authorization Bearer token is required' },
      });
    }

    const result = verifyHs256Jwt(match[1], secret, issuer);
    if (!result.valid) {
      return res.status(result.code === 'FORBIDDEN' ? 403 : 401).json({
        success: false,
        error: { code: result.code, message: result.message },
      });
    }

    req.auth = result.payload;
    return next();
  };
}

module.exports = { verifyHs256Jwt, createJwtAuthMiddleware };
