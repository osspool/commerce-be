/**
 * RMA Plugin — Fastify registration entry point.
 *
 * Converts the Arc resource to a Fastify plugin and wires the lifecycle
 * event subscribers (Flow moves on rma:received / rma:inspected).
 */

import rmaResource from './rma.resource.js';
import { wireRmaReceivedHandler } from './lifecycle/rma-received.handler.js';
import { wireRmaInspectedHandler } from './lifecycle/rma-inspected.handler.js';

wireRmaReceivedHandler();
wireRmaInspectedHandler();

export default rmaResource.toPlugin();
