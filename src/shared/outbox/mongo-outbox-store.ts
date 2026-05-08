import { type OutboxAcknowledgeOptions, type OutboxClaimOptions, type OutboxErrorInfo, type OutboxFailOptions, OutboxOwnershipError, type OutboxStore, type OutboxWriteOptions } from '@classytic/arc/events';
import type { DomainEvent } from '@classytic/primitives/events';
import mongoose, { type ClientSession, Schema } from 'mongoose';

function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

const outboxSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed },
    meta: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['pending', 'delivered', 'dead_letter'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    dedupeKey: { type: String, default: null },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    nextVisibleAt: { type: Date, default: Date.now },
    deliveredAt: { type: Date, default: null },
    lastError: {
      message: { type: String, default: null },
      code: { type: String, default: null },
      at: { type: Date, default: null },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

outboxSchema.index({ status: 1, nextVisibleAt: 1, createdAt: 1 });
outboxSchema.index({ deliveredAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
outboxSchema.index(
  { dedupeKey: 1 },
  { unique: true, sparse: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } },
);

const OutboxEvent = mongoose.models.OutboxEvent || mongoose.model('OutboxEvent', outboxSchema);

export class MongoOutboxStore implements OutboxStore {
  async save(event: DomainEvent, options?: OutboxWriteOptions): Promise<void> {
    if (!isConnected()) return;
    const session = options?.session as ClientSession | undefined;
    await OutboxEvent.create(
      [
        {
          eventId: event.meta.id,
          type: event.type,
          payload: event.payload,
          meta: event.meta,
          dedupeKey: options?.dedupeKey ?? null,
          nextVisibleAt: options?.visibleAt ?? new Date(),
        },
      ],
      { session },
    );
  }

  async getPending(limit: number): Promise<DomainEvent[]> {
    if (!isConnected()) return [];
    const now = new Date();
    const docs = await OutboxEvent.find({
      status: 'pending',
      nextVisibleAt: { $lte: now },
      $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }],
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
    return docs.map(toDomainEvent);
  }

  async claimPending(options?: OutboxClaimOptions): Promise<DomainEvent[]> {
    if (!isConnected()) return [];
    const now = new Date();
    const limit = options?.limit ?? 100;
    const leaseMs = options?.leaseMs ?? 30_000;
    const consumerId = options?.consumerId ?? 'anonymous';
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const claimed: DomainEvent[] = [];

    for (let i = 0; i < limit; i++) {
      const filter: Record<string, unknown> = {
        status: 'pending',
        nextVisibleAt: { $lte: now },
        $or: [{ leaseOwner: null }, { leaseExpiresAt: { $lte: now } }],
      };

      if (options?.types?.length) {
        filter.type = { $in: options.types };
      }

      const doc = await OutboxEvent.findOneAndUpdate(
        filter,
        {
          $set: {
            leaseOwner: consumerId,
            leaseExpiresAt,
          },
          $inc: { attempts: 1 },
        },
        { sort: { createdAt: 1 }, lean: true },
      );

      if (!doc) break;
      claimed.push(toDomainEvent(doc));
    }

    return claimed;
  }

  async acknowledge(eventId: string, options?: OutboxAcknowledgeOptions): Promise<void> {
    if (!isConnected()) return;
    if (!options?.consumerId) {
      await OutboxEvent.updateOne(
        { eventId },
        {
          $set: { status: 'delivered', deliveredAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
        },
      );
      return;
    }

    const result = await OutboxEvent.updateOne(
      { eventId, leaseOwner: options.consumerId },
      {
        $set: { status: 'delivered', deliveredAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
      },
    );
    if ((result.modifiedCount ?? 0) > 0 || (result.matchedCount ?? 0) === 0) return;

    const current = await OutboxEvent.findOne({ eventId }).select('leaseOwner').lean();
    throw new OutboxOwnershipError(
      eventId,
      options.consumerId,
      current ? ((current as { leaseOwner?: string | null }).leaseOwner ?? null) : null,
    );
  }

  async fail(eventId: string, error: OutboxErrorInfo, options?: OutboxFailOptions): Promise<void> {
    if (!isConnected()) return;
    const update = options?.deadLetter
      ? {
          $set: {
            status: 'dead_letter',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: { message: error.message, code: error.code ?? null, at: new Date() },
          },
        }
      : {
          $set: {
            status: 'pending',
            leaseOwner: null,
            leaseExpiresAt: null,
            nextVisibleAt: options?.retryAt ?? new Date(),
            lastError: { message: error.message, code: error.code ?? null, at: new Date() },
          },
        };

    if (!options?.consumerId) {
      await OutboxEvent.updateOne({ eventId }, update);
      return;
    }

    const result = await OutboxEvent.updateOne({ eventId, leaseOwner: options.consumerId }, update);
    if ((result.modifiedCount ?? 0) > 0 || (result.matchedCount ?? 0) === 0) return;

    const current = await OutboxEvent.findOne({ eventId }).select('leaseOwner').lean();
    throw new OutboxOwnershipError(
      eventId,
      options.consumerId,
      current ? ((current as { leaseOwner?: string | null }).leaseOwner ?? null) : null,
    );
  }

  // No manual `purge()` — the `{ deliveredAt: 1 }` TTL index above
  // (expireAfterSeconds: 7 days) already auto-purges delivered events.
  // A cron sweep would just race the TTL monitor on the same docs.
}

function toDomainEvent(doc: Record<string, unknown>): DomainEvent {
  return {
    type: doc.type as string,
    payload: doc.payload,
    meta: doc.meta as DomainEvent['meta'],
  };
}
