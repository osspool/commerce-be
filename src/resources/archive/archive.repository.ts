import fs from 'node:fs/promises';
import path from 'node:path';
import type { MongoOperationsMethods } from '@classytic/mongokit';
import { batchOperationsPlugin, methodRegistryPlugin, mongoOperationsPlugin, Repository } from '@classytic/mongokit';
import type mongoose from 'mongoose';
import { createDefaultLoader } from '#lib/utils/lazy-import.js';
import { getTransactionModel } from '#shared/revenue/engine.js';
import type { IArchive } from './archive.model.js';
import Archive from './archive.model.js';

const ARCHIVE_DIR = path.resolve(process.cwd(), 'storage', 'archives');
// Legacy stockMovement model removed — stock movements are now in Flow's StockMove collection.
// Archive for stock_movement type is disabled until Flow archive integration is implemented.

interface ArchiveRunParams {
  type: string;
  organizationId?: string;
  rangeFrom?: string | Date;
  rangeTo?: string | Date;
  ttlDays?: number;
}

export class ArchiveRepository extends Repository<IArchive> {
  constructor(model: mongoose.Model<IArchive> = Archive as mongoose.Model<IArchive>) {
    super(model, [methodRegistryPlugin(), mongoOperationsPlugin(), batchOperationsPlugin()]);
  }

  async ensureDir(): Promise<string> {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    return ARCHIVE_DIR;
  }

  async runArchive(
    { type, organizationId, rangeFrom, rangeTo, ttlDays }: ArchiveRunParams,
    _options: Record<string, unknown> = {},
  ) {
    await this.ensureDir();
    const from = rangeFrom ? new Date(rangeFrom) : new Date(0);
    const to = rangeTo ? new Date(rangeTo) : new Date();
    const match: Record<string, unknown> = { createdAt: { $gte: from, $lte: to } };

    if (organizationId && organizationId !== 'all') {
      if (type === 'stock_movement') {
        match.branch = organizationId;
      } else {
        match.organizationId = organizationId;
      }
    }

    let Model: mongoose.Model<any>;
    if (type === 'transaction') {
      Model = getTransactionModel();
    } else if (type === 'stock_movement') {
      throw new Error(
        "stock_movement archive not available — stock movements are managed by Flow engine. Use Flow's audit trail instead.",
      );
    } else {
      throw new Error(`Unsupported archive type: ${type}. Supported types: transaction, stock_movement`);
    }

    const cursor = Model.find(match).lean().cursor();
    const fileName = `${type}-${organizationId || 'org'}.json`;
    const filePath = path.join(ARCHIVE_DIR, fileName);
    let count = 0;
    let sizeBytes = 0;
    const fd = await fs.open(filePath, 'w');
    await fd.write('[\n');
    let first = true;

    for await (const doc of cursor) {
      const chunk = (first ? '' : ',\n') + JSON.stringify(doc);
      first = false;
      await fd.write(chunk);
      count += 1;
      sizeBytes += Buffer.byteLength(chunk);
    }

    await fd.write('\n]');
    await fd.close();

    const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : undefined;
    const archive = await (this as unknown as MongoOperationsMethods<unknown>).upsert(
      { type, organizationId },
      {
        rangeFrom: from,
        rangeTo: to,
        filePath,
        format: 'json',
        recordCount: count,
        sizeBytes,
        expiresAt,
        archivedAt: new Date(),
      },
    );

    await Model.deleteMany(match);
    return archive;
  }

  async cleanupExpiredAndOrphans(): Promise<void> {
    await this.ensureDir();
    const now = new Date();

    const expired = await this._executeQuery(async (Model: mongoose.Model<unknown>) => {
      return Model.find({ expiresAt: { $lte: now } }).lean();
    });

    for (const doc of expired as unknown as Array<{ _id: unknown; filePath: string }>) {
      await fs.unlink(doc.filePath).catch(() => null);
      await this.delete(String(doc._id));
    }

    const files = await fs.readdir(ARCHIVE_DIR).catch(() => [] as string[]);
    const docs = await this._executeQuery(async (Model: mongoose.Model<unknown>) => {
      return Model.find({}).select('filePath').lean();
    });
    const valid = new Set((docs as unknown as Array<{ filePath: string }>).map((d) => d.filePath));

    for (const f of files) {
      const full = path.join(ARCHIVE_DIR, f);
      if (!valid.has(full)) {
        await fs.unlink(full).catch(() => null);
      }
    }
  }
}

const archiveRepository = new ArchiveRepository();
export default archiveRepository;
