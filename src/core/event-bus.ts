import { logger } from './logger.js';

export interface QoopiaEvent {
  id: string;           // activity ID (ULID)
  workspace_id: string;
  entity_type: string;  // task, deal, contact, project, finance, agent, system
  entity_id?: string;
  project_id?: string;
  actor: string;
  action: string;       // created, updated, deleted
  summary: string;
  revision?: number;
  timestamp: string;
}

type EventHandler = (event: QoopiaEvent) => void;

interface Subscriber {
  id: string;
  workspace_id: string;
  handler: EventHandler;
  filters: {
    project_id?: string;
    entity_type?: string;
  };
}

class EventBus {
  private subscribers = new Map<string, Subscriber>();

  subscribe(sub: Subscriber): () => void {
    this.subscribers.set(sub.id, sub);
    logger.debug({ subscriber_id: sub.id, filters: sub.filters }, 'SSE subscriber added');
    return () => {
      this.subscribers.delete(sub.id);
      logger.debug({ subscriber_id: sub.id }, 'SSE subscriber removed');
    };
  }

  emit(event: QoopiaEvent): void {
    for (const sub of this.subscribers.values()) {
      // Workspace isolation
      if (sub.workspace_id !== event.workspace_id) continue;

      // Project filter
      if (sub.filters.project_id && event.project_id !== sub.filters.project_id) continue;

      // Entity type filter
      if (sub.filters.entity_type && event.entity_type !== sub.filters.entity_type) continue;

      try {
        sub.handler(event);
      } catch (err) {
        logger.error({ subscriber_id: sub.id, error: err }, 'SSE handler error');
      }
    }
  }

  closeAll(): void {
    // Subscribers will be cleaned up by their unsubscribe functions
    // This is called during graceful shutdown
    this.subscribers.clear();
    logger.info('All SSE subscribers cleared');
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

export const eventBus = new EventBus();
