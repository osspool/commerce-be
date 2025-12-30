import fs from 'node:fs/promises';
import path from 'node:path';
import { Repository, methodRegistryPlugin, mongoOperationsPlugin, batchOperationsPlugin } from '@classytic/mongokit';
import Archive from './archive.model.js';
import Transaction from '#modules/transaction/transaction.model.js';

const ARCHIVE_DIR = path.resolve(process.cwd(), 'storage', 'archives');

export class ArchiveRepository extends Repository {
  constructor(model = Archive) {
    super(model, [
      methodRegistryPlugin(),
      mongoOperationsPlugin(),
      batchOperationsPlugin(),
    ]);
  }

  async ensureDir() {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    return ARCHIVE_DIR;
  }

  async runArchive({ type, organizationId, rangeFrom, rangeTo, ttlDays }, options = {}) {
    await this.ensureDir();
    const from = rangeFrom ? new Date(rangeFrom) : new Date(0);
    const to = rangeTo ? new Date(rangeTo) : new Date();
    const match = { createdAt: { $gte: from, $lte: to } };

    // Apply organization/branch filter if provided
    if (organizationId && organizationId !== 'all') {
      if (type === 'stock_movement') {
        match.branch = organizationId; // For stock movements, use branch filter
      } else {
        match.organizationId = organizationId;
      }
    }

    let Model;
    if (type === 'transaction') {
      Model = Transaction;
    } else if (type === 'stock_movement') {
      const StockMovement = (await import('#modules/commerce/inventory/stockMovement.model.js')).default;
      Model = StockMovement;
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
    const archive = await this.upsert(
      { type, organizationId },
      { rangeFrom: from, rangeTo: to, filePath, format: 'json', recordCount: count, sizeBytes, expiresAt, archivedAt: new Date() }
    );

    // Delete archived records from original collection
    await Model.deleteMany(match);
    return archive;
  }

  async cleanupExpiredAndOrphans() {
    await this.ensureDir();
    const now = new Date();

    // Get expired archives
    const expired = await this._executeQuery(async (Model) => {
      return Model.find({ expiresAt: { $lte: now } }).lean();
    });

    // Delete expired archive files and records
    for (const doc of expired) {
      await fs.unlink(doc.filePath).catch(() => null);
      await this.delete(doc._id);
    }

    // Clean orphaned files
    const files = await fs.readdir(ARCHIVE_DIR).catch(() => []);
    const docs = await this._executeQuery(async (Model) => {
      return Model.find({}).select('filePath').lean();
    });
    const valid = new Set(docs.map((d) => d.filePath));

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
