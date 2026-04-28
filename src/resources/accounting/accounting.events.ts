/**
 * Accounting event handlers — entry point.
 *
 * The actual handlers live under `./events/handlers/` — one file per
 * posting type, each ~25–60 lines of pure domain logic. The factory
 * (`./events/define-posting-handler.ts`) owns all the cross-cutting
 * concerns: subscribe, retry, payload validation, branch resolution,
 * createPosting, structured logging.
 *
 * **To add a new accounting event:** create a `<name>.handler.ts` file
 * under `./events/handlers/`, then add it to `postingHandlers` in
 * `./events/posting-handlers.registry.ts`. No changes to this file.
 *
 * **To debug a handler in isolation:** import it from its file and call
 * `handler.build(payload, mockLogger)` — pure function, no event bus.
 *
 * @see ./events/define-posting-handler.ts — the factory + design notes
 * @see ./events/posting-handlers.registry.ts — the full posting strategy
 */

import config from "#config/index.js";
import logger from "#lib/utils/logger.js";
import { registerPostingHandler } from "./events/define-posting-handler.js";
import { postingHandlers } from "./events/posting-handlers.registry.js";

// Idempotency guard. `registerAccountingEventHandlers()` is called from
// three independent bootstrap paths (accounting.plugin.ts, cron/index.ts,
// core/factories/background-runtime.ts) so each entry point stays self-
// contained — but the event bus deduplicates by handler IDENTITY, not by
// pattern, so each call would otherwise install a fresh closure set and
// fan handlers out N×. Mirrors `notification.handlers.ts`.
let handlersRegistered = false;

export function registerAccountingEventHandlers(): void {
  if (!config.accounting.enabled || config.accounting.mode === "simple") {
    logger.info(
      { mode: config.accounting.mode },
      "Accounting auto-posting disabled",
    );
    return;
  }

  if (handlersRegistered) {
    logger.debug("Accounting event handlers already registered — skipping");
    return;
  }
  handlersRegistered = true;

  const options = {
    maxRetries: 3,
    backoffMs: 2000,
    autoSeedAccounts: config.accounting.autoSeedAccounts,
  };

  for (const handler of postingHandlers) {
    registerPostingHandler(handler, options, logger);
  }

  // Log event NAMES only — `h.event` is the full `EventDefinitionOutput`
  // (name + JSON schema + version + description). Dumping the whole
  // object produces a >2KB log line per boot with the entire Zod-derived
  // JSON schema for every handler. Names are enough for "what's wired";
  // the schemas are introspectable via OpenAPI / EventRegistry at runtime.
  logger.info(
    {
      mode: config.accounting.mode,
      count: postingHandlers.length,
      handlers: postingHandlers.map((h) => h.event.name),
    },
    "Accounting event handlers registered",
  );
}

export default { registerAccountingEventHandlers };
