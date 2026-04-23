/**
 * Invoice Workflows — durable background jobs via @classytic/streamline.
 *
 * These workflows replace cron-based manual triggers for:
 * - Dunning: check overdue → send reminders → sleep 24h → repeat
 * - Recurring: generate scheduled invoices → complete
 *
 * The invoice engine's services are the handlers; Streamline orchestrates
 * when they run (crash-safe, with retry, sleep, and durable execution).
 *
 * `createInvoiceWorkflows(container)` is the factory consumed by
 * `streamline.plugin.ts`. Factory style is required so every workflow
 * shares ONE `StreamlineContainer` — without a shared container each
 * `createWorkflow()` call would spin up its own isolated event bus and
 * Arc's `bridgeStepEvents` / SSE streaming would silently no-op.
 */

import { createWorkflow, type StreamlineContainer } from '@classytic/streamline';
import { invoice } from './invoice-engine.js';

interface InvoiceWorkflowInput {
  organizationId?: string;
  actorId?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: createWorkflow return type is heavily generic; plugin collects them as `any[]`
export function createInvoiceWorkflows(container: StreamlineContainer): any[] {
  // ── Dunning ────────────────────────────────────────────────────────────────
  // Checks overdue invoices and sends payment reminders.
  // Loops with a 24h durable sleep between cycles.
  const dunning = createWorkflow<InvoiceWorkflowInput>('invoice-dunning', {
    container,
    steps: {
      process: {
        handler: async (ctx) => {
          const input = ctx.input as InvoiceWorkflowInput;
          return invoice().services.dunning.processDunning(input);
        },
        retries: 3,
      },
      wait: {
        handler: async (ctx) => {
          await ctx.sleep(24 * 60 * 60 * 1000);
          await ctx.goto('process');
        },
      },
    },
  });

  // ── Recurring invoicing ────────────────────────────────────────────────────
  // Generates invoices from recurring templates that are due.
  // One-shot per execution — schedule via Streamline's SchedulingService.
  const recurring = createWorkflow<InvoiceWorkflowInput>('invoice-recurring', {
    container,
    steps: {
      generate: {
        handler: async (ctx) => {
          const input = ctx.input as InvoiceWorkflowInput;
          const result = await invoice().services.recurring.processScheduled(input);
          return { count: Array.isArray(result) ? result.length : 0 };
        },
        retries: 3,
      },
    },
  });

  return [dunning, recurring];
}
