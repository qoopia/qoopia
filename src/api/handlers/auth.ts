import { Hono } from 'hono';
import crypto from 'node:crypto';
import { ulid } from 'ulid';
import { rawDb } from '../../db/connection.js';
import { logger } from '../../core/logger.js';

const app = new Hono();

const MAGIC_LINK_EXPIRY_MIN = 15;
const SESSION_EXPIRY_DAYS = 30;
const RESEND_RETRY_DELAY_MS = 1000;

function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendMagicLinkEmail(payload: {
  resendApiKey: string;
  email: string;
  userName: string;
  userId: string;
  verifyUrl: string;
}): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${payload.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Qoopia <noreply@qoopia.ai>',
          to: [payload.email],
          subject: 'Your Qoopia login link',
          html: `
            <p>Hi ${payload.userName},</p>
            <p>Click the link below to sign in to Qoopia:</p>
            <p><a href="${payload.verifyUrl}">${payload.verifyUrl}</a></p>
            <p>This link expires in ${MAGIC_LINK_EXPIRY_MIN} minutes.</p>
            <p>If you didn't request this, you can safely ignore this email.</p>
          `,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        logger.info({ email: payload.email, user_id: payload.userId }, 'Magic link email sent');
        return true;
      }

      const err = await response.text().catch(() => 'unknown error');
      if (attempt < 2) {
        logger.warn({ email: payload.email, attempt, retry_in_ms: RESEND_RETRY_DELAY_MS, status: response.status, error: err }, 'Retrying Resend magic link email');
        await sleep(RESEND_RETRY_DELAY_MS);
        continue;
      }

      logger.error({ status: response.status, error: err }, 'Resend email failed');
      return false;
    } catch (error) {
      if (attempt < 2) {
        logger.warn({ email: payload.email, attempt, retry_in_ms: RESEND_RETRY_DELAY_MS, error }, 'Retrying Resend magic link email');
        await sleep(RESEND_RETRY_DELAY_MS);
        continue;
      }

      logger.error({ error }, 'Failed to send magic link email');
      return false;
    }
  }

  return false;
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
    await sendMagicLinkEmail({
      resendApiKey,
      email,
      userName: user.name,
      userId: user.id,
      verifyUrl,
    });
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
