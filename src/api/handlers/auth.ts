import { Hono } from 'hono';
import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { logger } from '../../core/logger.js';

const app = new Hono();

const MAGIC_LINK_EXPIRY_MIN = 15;
const SESSION_EXPIRY_DAYS = 30;

function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

// POST /api/v1/auth/magic-link — request a magic link
app.post('/magic-link', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !body.email) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'email is required' }
    }, 400);
  }

  const email = (body.email as string).toLowerCase().trim();

  // Find user by email
  const user = rawDb.prepare(
    'SELECT id, workspace_id, name FROM users WHERE email = ?'
  ).get(email) as { id: string; workspace_id: string; name: string } | undefined;

  // Always return 200 to prevent email enumeration
  if (!user) {
    logger.warn({ email }, 'Magic link requested for unknown email');
    return c.json({
      message: 'If an account exists with this email, a magic link has been sent.',
    });
  }

  // Generate token
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const id = ulid();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MIN * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z/, 'Z');

  rawDb.prepare(`
    INSERT INTO magic_links (id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(id, user.id, tokenHash, expiresAt);

  // Send email via Resend if configured
  const resendApiKey = process.env.RESEND_API_KEY;
  const baseUrl = process.env.QOOPIA_PUBLIC_URL || `http://localhost:${process.env.PORT || '3000'}`;
  const verifyUrl = `${baseUrl}/api/v1/auth/verify?token=${rawToken}`;

  if (resendApiKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Qoopia <noreply@qoopia.ai>',
          to: [email],
          subject: 'Your Qoopia login link',
          html: `
            <p>Hi ${user.name},</p>
            <p>Click the link below to sign in to Qoopia:</p>
            <p><a href="${verifyUrl}">${verifyUrl}</a></p>
            <p>This link expires in ${MAGIC_LINK_EXPIRY_MIN} minutes.</p>
            <p>If you didn't request this, you can safely ignore this email.</p>
          `,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => 'unknown error');
        logger.error({ status: response.status, error: err }, 'Resend email failed');
      } else {
        logger.info({ email, user_id: user.id }, 'Magic link email sent');
      }
    } catch (err) {
      logger.error({ error: err }, 'Failed to send magic link email');
    }
  } else {
    // Dev mode: log the link
    logger.info({
      email,
      verify_url: `${baseUrl}/api/v1/auth/verify?token=${rawToken.slice(0, 8)}***`,
    }, 'Magic link (dev mode — no RESEND_API_KEY)');
  }

  return c.json({
    message: 'If an account exists with this email, a magic link has been sent.',
  });
});

// GET /api/v1/auth/verify?token=xxx — verify magic link and create session
app.get('/verify', (c) => {
  const token = c.req.query('token');
  if (!token) {
    return c.json({
      error: { code: 'VALIDATION_ERROR', message: 'token query parameter is required' }
    }, 400);
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');

  const link = rawDb.prepare(`
    SELECT ml.id, ml.user_id, ml.expires_at, u.workspace_id, u.name, u.email, u.role
    FROM magic_links ml
    JOIN users u ON u.id = ml.user_id
    WHERE ml.token_hash = ? AND ml.used_at IS NULL
  `).get(tokenHash) as {
    id: string; user_id: string; expires_at: string;
    workspace_id: string; name: string; email: string; role: string;
  } | undefined;

  if (!link) {
    return c.json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or already used token' }
    }, 401);
  }

  if (link.expires_at < now) {
    return c.json({
      error: { code: 'UNAUTHORIZED', message: 'Token has expired' }
    }, 401);
  }

  // Mark as used
  rawDb.prepare("UPDATE magic_links SET used_at = ? WHERE id = ?").run(now, link.id);

  // Generate session token (API key style for simplicity)
  const sessionToken = `qp_s_${crypto.randomBytes(32).toString('hex')}`;
  const sessionHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  const sessionExpires = new Date(Date.now() + SESSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z/, 'Z');

  // HIGH #6: Store session with server-side expiry
  rawDb.prepare("UPDATE users SET api_key_hash = ?, session_expires_at = ?, last_seen = ? WHERE id = ?")
    .run(sessionHash, sessionExpires, now, link.user_id);

  logger.info({ user_id: link.user_id, email: link.email }, 'Magic link verified, session created');

  // Set session cookie
  const requestUrl = new URL(c.req.url);
  const secureAttr = isLocalhostHost(requestUrl.hostname) ? '' : '; Secure';
  const cookieValue = `qp_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=${SESSION_EXPIRY_DAYS * 86400}`;
  c.header('Set-Cookie', cookieValue);

  return c.json({
    data: {
      user_id: link.user_id,
      name: link.name,
      email: link.email,
      role: link.role,
      workspace_id: link.workspace_id,
      expires_at: sessionExpires,
    },
    message: 'Authenticated successfully',
  });
});

export default app;
