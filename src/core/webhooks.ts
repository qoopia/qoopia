import { ulid } from 'ulid';
import { rawDb } from '../db/connection.js';
import { logger } from './logger.js';
import type { QoopiaEvent } from './event-bus.js';

interface WebhookConfig {
  id: string;
  type: 'telegram' | 'http';
  config: {
    bot_token?: string;
    chat_id?: string;
    url?: string;
    headers?: Record<string, string>;
  };
  events: string[];  // ['task.overdue', 'deal.updated', '*']
  active: boolean;
}

interface WebhookPayload {
  event: string;
  timestamp: string;
  workspace_id: string;
  data: Record<string, unknown>;
}

const BACKOFF_BASE = 4;  // exponential base: 1s, 4s, 16s
const MAX_ATTEMPTS = 3;

function getWorkspaceWebhooks(workspaceId: string): WebhookConfig[] {
  const row = rawDb.prepare(
    'SELECT settings FROM workspaces WHERE id = ?'
  ).get(workspaceId) as { settings: string } | undefined;

  if (!row) return [];

  try {
    const settings = JSON.parse(row.settings);
    return (settings.webhooks || []).filter((wh: WebhookConfig) => wh.active);
  } catch {
    return [];
  }
}

function matchesEvent(webhookEvents: string[], eventName: string): boolean {
  return webhookEvents.includes('*') || webhookEvents.includes(eventName);
}

function isPrivateHost(hostname: string): boolean {
  // Block IPv6 loopback and private ranges
  if (hostname === '::1' || hostname === '[::1]') return true;
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true; // fc00::/7
  if (hostname.startsWith('fe80')) return true; // link-local

  // Resolve common names
  if (hostname === 'localhost' || hostname.endsWith('.local')) return true;

  // IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true;                              // 127.0.0.0/8
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16 link-local
    if (a === 0) return true;                                // 0.0.0.0/8
  }

  return false;
}

async function deliverWebhook(webhook: WebhookConfig, payload: WebhookPayload): Promise<void> {
  let url: string;
  let body: string;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (webhook.type === 'telegram') {
    const { bot_token, chat_id } = webhook.config;
    url = `https://api.telegram.org/bot${bot_token}/sendMessage`;
    body = JSON.stringify({
      chat_id,
      text: formatTelegramMessage(payload),
      parse_mode: 'HTML',
    });
  } else {
    url = webhook.config.url!;
    body = JSON.stringify(payload);
    if (webhook.config.headers) {
      headers = { ...headers, ...webhook.config.headers };
    }
  }

  // SSRF protection: block private/internal network targets
  try {
    const parsed = new URL(url);
    if (isPrivateHost(parsed.hostname)) {
      logger.warn({ webhook_id: webhook.id, url }, 'Webhook blocked: private network target');
      return;
    }
  } catch {
    logger.warn({ webhook_id: webhook.id, url }, 'Webhook blocked: invalid URL');
    return;
  }

  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10_000),  // 10s timeout
      });

      if (response.ok) {
        logger.debug({ webhook_id: webhook.id, attempt }, 'Webhook delivered');
        return;
      }

      lastError = `HTTP ${response.status} ${response.statusText}`;
      logger.warn({ webhook_id: webhook.id, attempt, status: response.status }, 'Webhook delivery failed');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ webhook_id: webhook.id, attempt, error: lastError }, 'Webhook delivery error');
    }

    // Exponential backoff: 1s, 4s, 16s
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = Math.pow(BACKOFF_BASE, attempt) * 250;  // 1000ms, 4000ms, 16000ms
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // All attempts failed — insert dead letter
  const deadLetterId = ulid();
  const now = new Date().toISOString().replace(/\.\d{3}Z/, 'Z');

  rawDb.prepare(`
    INSERT INTO webhook_dead_letters (id, webhook_url, payload, attempts, last_attempt_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deadLetterId, url, body, MAX_ATTEMPTS, now, lastError);

  logger.error({ webhook_id: webhook.id, dead_letter_id: deadLetterId }, 'Webhook delivery exhausted, inserted dead letter');
}

function formatTelegramMessage(payload: WebhookPayload): string {
  const { event, data } = payload;
  const entityType = data.entity_type || 'entity';
  const title = data.title || data.name || data.summary || '';
  return `<b>${event}</b>\n${entityType}: ${title}\n${payload.timestamp}`;
}

export function dispatchWebhooks(event: QoopiaEvent): void {
  const webhooks = getWorkspaceWebhooks(event.workspace_id);
  if (webhooks.length === 0) return;

  const eventName = `${event.entity_type}.${event.action}`;
  const payload: WebhookPayload = {
    event: eventName,
    timestamp: event.timestamp,
    workspace_id: event.workspace_id,
    data: {
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      actor: event.actor,
      action: event.action,
      summary: event.summary,
      revision: event.revision,
    },
  };

  for (const webhook of webhooks) {
    if (matchesEvent(webhook.events, eventName)) {
      // Fire and forget — don't block the event bus
      deliverWebhook(webhook, payload).catch(err => {
        logger.error({ webhook_id: webhook.id, error: err }, 'Unhandled webhook error');
      });
    }
  }
}
