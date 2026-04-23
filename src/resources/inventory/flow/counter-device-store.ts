/**
 * Counter-backed DeviceSequenceStore for OfflineSyncService.
 *
 * Uses Flow's Counter model for persistent, atomic device sequence tracking.
 * Server restarts no longer lose duplicate detection state.
 *
 * The model resolver is lazy — it fetches the Counter model on first access
 * (after the Flow engine is initialized).
 */
import type { Model } from 'mongoose';

interface CounterDoc {
  organizationId: string;
  prefix: string;
  currentValue: number;
}

/** Port interface from @classytic/flow */
interface DeviceSequenceStore {
  get(organizationId: string, deviceId: string): Promise<number>;
  set(organizationId: string, deviceId: string, sequence: number): Promise<void>;
}

export class CounterDeviceSequenceStore implements DeviceSequenceStore {
  private _model: Model<CounterDoc> | null = null;

  constructor(private modelResolver: () => Model<CounterDoc> | null) {}

  private get model(): Model<CounterDoc> {
    if (!this._model) {
      this._model = this.modelResolver();
    }
    if (!this._model) throw new Error('Counter model not available');
    return this._model;
  }

  async get(organizationId: string, deviceId: string): Promise<number> {
    const doc = await this.model
      .findOne({
        organizationId,
        prefix: `offline-sync:${deviceId}`,
      })
      .lean();
    return (doc as CounterDoc | null)?.currentValue ?? 0;
  }

  async set(organizationId: string, deviceId: string, sequence: number): Promise<void> {
    await this.model.findOneAndUpdate(
      { organizationId, prefix: `offline-sync:${deviceId}` },
      { $set: { currentValue: sequence } },
      { upsert: true },
    );
  }
}
