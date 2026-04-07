import mongoose, { Schema } from 'mongoose';
import type { OutboxStore, DomainEvent } from '@classytic/arc/events';

const outboxSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed },
    meta: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['pending', 'delivered'], default: 'pending' },
    claimedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

outboxSchema.index({ status: 1, createdAt: 1 });
outboxSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }); // TTL 7 days

const OutboxEvent = mongoose.models.OutboxEvent || mongoose.model('OutboxEvent', outboxSchema);

// Stale claim threshold — if a pending event was claimed but not acknowledged
// within this time, it's eligible to be re-claimed by the next relay.
const STALE_CLAIM_MS = 60_000; // 1 minute

export class MongoOutboxStore implements OutboxStore {
  async save(event: DomainEvent): Promise<void> {
    await OutboxEvent.create({
      eventId: event.meta.id,
      type: event.type,
      payload: event.payload,
      meta: event.meta,
    });
  }

  /**
   * Atomically claim pending events using findOneAndUpdate.
   * Prevents concurrent relay() calls from double-publishing.
   *
   * Uses claimedAt timestamp to detect stale claims — if a previous relay
   * crashed after claiming but before acknowledging, the event becomes
   * re-claimable after STALE_CLAIM_MS.
   */
  async getPending(limit: number): Promise<DomainEvent[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

    const claimed: DomainEvent[] = [];

    for (let i = 0; i < limit; i++) {
      const doc = await OutboxEvent.findOneAndUpdate(
        {
          status: 'pending',
          $or: [
            { claimedAt: null }, // never claimed
            { claimedAt: { $lt: staleBefore } }, // stale claim — previous relay crashed
          ],
        },
        { claimedAt: now },
        { sort: { createdAt: 1 }, lean: true },
      );

      if (!doc) break;

      claimed.push({
        type: (doc as Record<string, unknown>).type as string,
        payload: (doc as Record<string, unknown>).payload,
        meta: (doc as Record<string, unknown>).meta as DomainEvent['meta'],
      });
    }

    return claimed;
  }

  async acknowledge(eventId: string): Promise<void> {
    await OutboxEvent.updateOne({ eventId }, { status: 'delivered' });
  }
}
