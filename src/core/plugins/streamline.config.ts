/**
 * Streamline Workflow Engine Configuration
 *
 * Controls the @classytic/streamline global registration.
 * When enabled, workflows (dunning, recurring invoicing, etc.) execute
 * as durable, crash-safe background jobs instead of setInterval.
 */

export interface StreamlineConfigSection {
  streamline: {
    /** Master switch — enables Streamline workflow engine. */
    enabled: boolean;
    /** Auto-delete completed workflow runs after N days. Default: 30. */
    ttlDays: number;
    /** Scheduler poll interval in ms. Default: 60000 (1 min). */
    pollIntervalMs: number;
  };
}

const streamline: StreamlineConfigSection['streamline'] = {
  enabled: process.env.STREAMLINE_ENABLED !== 'false',
  ttlDays: parseInt(process.env.STREAMLINE_TTL_DAYS || '30', 10),
  pollIntervalMs: parseInt(process.env.STREAMLINE_POLL_INTERVAL_MS || '60000', 10),
};

const streamlineConfig: StreamlineConfigSection = { streamline };

export default streamlineConfig;
