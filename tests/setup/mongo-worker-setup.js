import fs from 'fs';
import path from 'path';

const mongoStatePath = path.resolve(process.cwd(), 'tests/setup/.mongo-test-state.json');

if (!process.env.MONGO_URI && fs.existsSync(mongoStatePath)) {
  try {
    const { uri } = JSON.parse(fs.readFileSync(mongoStatePath, 'utf8'));
    if (uri) {
      process.env.MONGO_URI = uri;
      globalThis.__MONGO_URI__ = uri;
    }
  } catch {
    // Best-effort bridge for worker processes on Windows.
  }
}
