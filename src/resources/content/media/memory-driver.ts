/**
 * In-memory storage driver — tests only.
 *
 * Conforms to media-kit v3's `StorageDriver` interface so the engine can
 * fall back to a heap-backed store when no S3 bucket is configured.
 */
import { Readable } from 'node:stream';
import type { FileStat, PresignedUploadResult, StorageDriver, WriteResult } from '@classytic/media-kit';

interface MemoryFile {
  buffer: Buffer;
  contentType: string;
  lastModified: Date;
}

export async function createMemoryDriver(): Promise<StorageDriver> {
  const store = new Map<string, MemoryFile>();

  async function toBuffer(input: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
    if (Buffer.isBuffer(input)) return input;
    const chunks: Buffer[] = [];
    for await (const chunk of input as AsyncIterable<unknown>) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  return {
    name: 'memory',

    async write(key, data, contentType): Promise<WriteResult> {
      const buffer = await toBuffer(data);
      store.set(key, { buffer, contentType, lastModified: new Date() });
      return { key, url: `memory://${key}`, size: buffer.length };
    },

    async read(key): Promise<NodeJS.ReadableStream> {
      const f = store.get(key);
      if (!f) throw new Error(`Not found: ${key}`);
      return Readable.from(f.buffer);
    },

    async delete(key): Promise<boolean> {
      return store.delete(key);
    },

    async exists(key): Promise<boolean> {
      return store.has(key);
    },

    async stat(key): Promise<FileStat> {
      const f = store.get(key);
      if (!f) throw new Error(`Not found: ${key}`);
      return {
        size: f.buffer.length,
        contentType: f.contentType,
        lastModified: f.lastModified,
      };
    },

    getPublicUrl(key): string {
      return `memory://${key}`;
    },

    async getSignedUploadUrl(key, _contentType, expiresIn): Promise<PresignedUploadResult> {
      return {
        uploadUrl: `memory://${key}?upload=1`,
        key,
        publicUrl: `memory://${key}`,
        expiresIn: expiresIn ?? 3600,
      };
    },
  };
}
