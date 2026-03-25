import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ulid } from 'ulid';
import { eventBus, type QoopiaEvent } from '../../core/event-bus.js';
import type { AuthContext } from '../../types/index.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds

app.get('/', (c) => {
  const auth = c.get('auth');
  const projectId = c.req.query('project_id');
  const entityType = c.req.query('entity_type');

  return streamSSE(c, async (stream) => {
    const subscriberId = ulid();

    // Queue for events received while writing
    const eventQueue: QoopiaEvent[] = [];
    let closed = false;

    const unsubscribe = eventBus.subscribe({
      id: subscriberId,
      workspace_id: auth.workspace_id,
      handler: (event) => {
        if (!closed) {
          eventQueue.push(event);
        }
      },
      filters: {
        project_id: projectId,
        entity_type: entityType,
      },
    });

    // Cleanup on disconnect
    stream.onAbort(() => {
      closed = true;
      unsubscribe();
    });

    // Main loop: heartbeats + event draining
    while (!closed) {
      // Drain queued events
      while (eventQueue.length > 0 && !closed) {
        const event = eventQueue.shift()!;
        await stream.writeSSE({
          event: `${event.entity_type}.${event.action}`,
          id: event.id,
          data: JSON.stringify({
            entity_type: event.entity_type,
            entity_id: event.entity_id,
            actor: event.actor,
            action: event.action,
            summary: event.summary,
            revision: event.revision,
            timestamp: event.timestamp,
            project_id: event.project_id,
          }),
        });
      }

      // Heartbeat — write comment to keep connection alive
      if (!closed) {
        await stream.writeSSE({ event: '', data: '', comment: 'heartbeat' });
      }

      // Wait for next heartbeat interval (or break early if events arrive)
      if (!closed) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, HEARTBEAT_INTERVAL);
          // Check every 100ms for new events to reduce latency
          const checker = setInterval(() => {
            if (eventQueue.length > 0 || closed) {
              clearTimeout(timer);
              clearInterval(checker);
              resolve();
            }
          }, 100);
          // Cleanup interval on timeout
          setTimeout(() => clearInterval(checker), HEARTBEAT_INTERVAL);
        });
      }
    }
  });
});

export default app;
