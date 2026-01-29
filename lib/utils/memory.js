/**
 * Memory Management Utilities
 *
 * Smart memory cleanup and monitoring for Node.js applications.
 * Implements best practices for garbage collection and memory optimization.
 */

/**
 * Get current memory usage
 */
export function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // Resident Set Size (MB)
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // Total heap (MB)
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // Used heap (MB)
    external: Math.round(usage.external / 1024 / 1024), // C++ objects (MB)
    arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024), // ArrayBuffers (MB)
  };
}

/**
 * Format memory usage for logging
 */
export function formatMemoryUsage() {
  const usage = getMemoryUsage();
  return `RSS: ${usage.rss}MB | Heap: ${usage.heapUsed}/${usage.heapTotal}MB | External: ${usage.external}MB`;
}

/**
 * Check if memory usage is within healthy limits
 *
 * @param {Object} limits - Memory limits in MB
 * @param {number} limits.rss - Max RSS (default: 1024MB)
 * @param {number} limits.heapUsed - Max heap used (default: 512MB)
 * @returns {Object} Status and current usage
 */
export function checkMemoryHealth(limits = {}) {
  const defaultLimits = {
    rss: 1024, // 1GB
    heapUsed: 512, // 512MB
  };
  const finalLimits = { ...defaultLimits, ...limits };
  const usage = getMemoryUsage();

  const healthy = usage.rss < finalLimits.rss && usage.heapUsed < finalLimits.heapUsed;

  return {
    healthy,
    usage,
    limits: finalLimits,
    warnings: [
      usage.rss >= finalLimits.rss && `RSS (${usage.rss}MB) exceeds limit (${finalLimits.rss}MB)`,
      usage.heapUsed >= finalLimits.heapUsed &&
        `Heap (${usage.heapUsed}MB) exceeds limit (${finalLimits.heapUsed}MB)`,
    ].filter(Boolean),
  };
}

/**
 * Force garbage collection if available
 *
 * Run with: node --expose-gc index.js
 *
 * @returns {boolean} True if GC was triggered
 */
export function forceGC() {
  if (global.gc) {
    const before = getMemoryUsage();
    global.gc();
    const after = getMemoryUsage();
    const freed = before.heapUsed - after.heapUsed;
    console.log(`🧹 GC: Freed ${freed}MB (${before.heapUsed}MB → ${after.heapUsed}MB)`);
    return true;
  }
  return false;
}

/**
 * Monitor memory usage at intervals
 *
 * @param {Object} options
 * @param {number} options.intervalMs - Check interval (default: 60000ms = 1 min)
 * @param {Function} options.onWarning - Callback when memory exceeds limits
 * @param {Object} options.limits - Memory limits { rss, heapUsed }
 * @param {Object} options.logger - Logger instance (optional)
 * @returns {Function} Stop monitoring function
 */
export function monitorMemory(options = {}) {
  const {
    intervalMs = 60000, // 1 minute
    onWarning = null,
    limits = {},
    logger = console,
  } = options;

  let warningCount = 0;
  const maxWarnings = 3; // Trigger aggressive GC after 3 warnings

  const interval = setInterval(() => {
    const health = checkMemoryHealth(limits);

    if (!health.healthy) {
      warningCount++;
      logger.warn('⚠️  Memory usage high', {
        usage: health.usage,
        limits: health.limits,
        warnings: health.warnings,
      });

      if (onWarning) {
        onWarning(health);
      }

      // Aggressive cleanup after repeated warnings
      if (warningCount >= maxWarnings) {
        logger.warn('🔥 Memory pressure detected, forcing GC');
        forceGC();
        warningCount = 0; // Reset counter
      }
    } else {
      warningCount = 0; // Reset counter when healthy
      logger.debug('✅ Memory usage healthy', { usage: health.usage });
    }
  }, intervalMs);

  // Return cleanup function
  return () => {
    clearInterval(interval);
    logger.info('Memory monitoring stopped');
  };
}

/**
 * Get Node.js process info
 */
export function getProcessInfo() {
  return {
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuUsage: process.cpuUsage(),
  };
}

/**
 * Create a memory snapshot for debugging
 *
 * Returns a summary of current memory state
 */
export function createMemorySnapshot() {
  return {
    timestamp: new Date().toISOString(),
    memory: getMemoryUsage(),
    process: getProcessInfo(),
  };
}

/**
 * Smart cleanup for long-running processes
 *
 * Call this periodically (e.g., after processing a large batch)
 * to release memory back to the OS.
 *
 * @param {Object} options
 * @param {boolean} options.force - Force GC even if not available
 * @param {Object} options.logger - Logger instance
 */
export function smartCleanup(options = {}) {
  const { force = false, logger = console } = options;

  const before = getMemoryUsage();

  // Clear timer references (helps with memory leaks)
  if (global.gc || force) {
    // Force GC if available
    const gcTriggered = forceGC();

    if (!gcTriggered && force) {
      logger.warn('⚠️  GC not available. Run with: node --expose-gc index.js');
    }
  }

  const after = getMemoryUsage();
  const freed = before.heapUsed - after.heapUsed;

  if (freed > 0) {
    logger.info(`✨ Cleanup: Freed ${freed}MB`, {
      before: before.heapUsed,
      after: after.heapUsed,
    });
  }

  return { before, after, freed };
}

/**
 * Create a memory leak detector
 *
 * Monitors heap growth over time and alerts if consistent growth detected
 *
 * @param {Object} options
 * @param {number} options.intervalMs - Check interval (default: 30000ms = 30s)
 * @param {number} options.samples - Number of samples to track (default: 10)
 * @param {number} options.threshold - Growth threshold in MB (default: 50MB)
 * @param {Function} options.onLeak - Callback when leak detected
 * @param {Object} options.logger - Logger instance
 * @returns {Function} Stop detector function
 */
export function createLeakDetector(options = {}) {
  const {
    intervalMs = 30000, // 30 seconds
    samples = 10,
    threshold = 50, // 50MB growth
    onLeak = null,
    logger = console,
  } = options;

  const heapSamples = [];

  const interval = setInterval(() => {
    const usage = getMemoryUsage();
    heapSamples.push(usage.heapUsed);

    // Keep only last N samples
    if (heapSamples.length > samples) {
      heapSamples.shift();
    }

    // Check for consistent growth
    if (heapSamples.length === samples) {
      const first = heapSamples[0];
      const last = heapSamples[heapSamples.length - 1];
      const growth = last - first;

      if (growth > threshold) {
        // Check if it's consistent growth (not just a spike)
        const isConsistent = heapSamples.every((sample, i) => {
          if (i === 0) return true;
          return sample >= heapSamples[i - 1];
        });

        if (isConsistent) {
          logger.error('🚨 MEMORY LEAK DETECTED', {
            growth: `${growth}MB over ${samples} samples`,
            first: `${first}MB`,
            last: `${last}MB`,
            samples: heapSamples,
          });

          if (onLeak) {
            onLeak({ growth, samples: heapSamples, usage });
          }

          // Reset samples after alert
          heapSamples.length = 0;
        }
      }
    }
  }, intervalMs);

  return () => {
    clearInterval(interval);
    logger.info('Leak detector stopped');
  };
}

/**
 * Fastify plugin for memory monitoring
 *
 * @example
 * import { memoryMonitorPlugin } from './lib/utils/memory.js';
 *
 * await fastify.register(memoryMonitorPlugin, {
 *   intervalMs: 60000, // 1 minute
 *   limits: { rss: 1024, heapUsed: 512 },
 * });
 */
export async function memoryMonitorPlugin(fastify, options = {}) {
  const stopMonitor = monitorMemory({
    ...options,
    logger: fastify.log,
    onWarning: (health) => {
      // Emit event for alerting systems
      fastify.log.warn('Memory warning', health);
    },
  });

  // Add /memory endpoint
  fastify.get('/memory', async () => {
    return createMemorySnapshot();
  });

  // Cleanup on close
  fastify.addHook('onClose', async () => {
    stopMonitor();
  });

  fastify.log.info('Memory monitoring enabled', {
    intervalMs: options.intervalMs || 60000,
    limits: options.limits,
  });
}
