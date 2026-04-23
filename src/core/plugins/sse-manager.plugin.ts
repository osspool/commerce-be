/**
 * SSE Manager Plugin
 *
 * Manages Server-Sent Events connections for real-time notification delivery.
 * Decorates fastify with `sseManager` for pushing events to connected clients.
 *
 * Connections are keyed by userId:organizationId for branch-scoped delivery.
 */

import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import config from '#config/index.js';

interface SSELogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export class SSEManager {
  private connections = new Map<string, Set<ServerResponse>>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs: number;
  logger: SSELogger | null = null;

  constructor(heartbeatMs = 30_000) {
    this.heartbeatMs = heartbeatMs;
  }

  private getKey(userId: string, orgId: string): string {
    return `${userId}:${orgId}`;
  }

  addConnection(userId: string, orgId: string, res: ServerResponse): void {
    const key = this.getKey(userId, orgId);
    let set = this.connections.get(key);
    if (!set) {
      set = new Set();
      this.connections.set(key, set);
    }
    set.add(res);
    const openedAt = Date.now();
    this.logger?.info({ key, total: set.size }, '[sse] connection opened');

    res.on('close', () => {
      const durationMs = Date.now() - openedAt;
      this.logger?.info(
        { key, durationMs, writableEnded: res.writableEnded },
        '[sse] connection closed',
      );
      this.removeConnection(userId, orgId, res);
    });

    if (!this.heartbeatInterval) {
      this.startHeartbeat();
    }
  }

  removeConnection(userId: string, orgId: string, res: ServerResponse): void {
    const key = this.getKey(userId, orgId);
    const set = this.connections.get(key);
    if (set) {
      set.delete(res);
      if (set.size === 0) this.connections.delete(key);
    }

    // Stop heartbeat if no connections
    if (this.connections.size === 0 && this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Push an event to a specific user in a specific branch. */
  push(userId: string, orgId: string, event: string, data: unknown): void {
    const key = this.getKey(userId, orgId);
    const set = this.connections.get(key);
    if (!set || set.size === 0) return;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      if (!res.writableEnded) {
        res.write(payload);
      }
    }
  }

  /** Broadcast an event to all users in a branch. */
  broadcast(orgId: string, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [key, set] of this.connections) {
      if (key.endsWith(`:${orgId}`)) {
        for (const res of set) {
          if (!res.writableEnded) {
            res.write(payload);
          }
        }
      }
    }
  }

  /** Get connection stats for health/metrics. */
  getStats(): { totalConnections: number; uniqueUsers: number } {
    let totalConnections = 0;
    for (const set of this.connections.values()) {
      totalConnections += set.size;
    }
    return { totalConnections, uniqueUsers: this.connections.size };
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const comment = `:keepalive\n\n`;
      for (const set of this.connections.values()) {
        for (const res of set) {
          if (!res.writableEnded) {
            res.write(comment);
          }
        }
      }
    }, this.heartbeatMs);

    // Unref so the interval doesn't keep the process alive
    this.heartbeatInterval.unref();
  }

  /** Close all connections and stop heartbeat. */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const set of this.connections.values()) {
      for (const res of set) {
        if (!res.writableEnded) res.end();
      }
    }
    this.connections.clear();
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    sseManager: SSEManager;
  }
}

const sseManagerPlugin: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  const manager = new SSEManager(config.notifications?.ttlDays ? 30_000 : 30_000);
  manager.logger = fastify.log;
  fastify.decorate('sseManager', manager);

  fastify.addHook('onClose', () => {
    manager.shutdown();
  });
};

export default fp(sseManagerPlugin, {
  name: 'sse-manager',
  fastify: '5.x',
});
