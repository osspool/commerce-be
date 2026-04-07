// src/config/sections/inventory.config.ts
import type { FlowMode } from '@classytic/flow';

const VALID_MODES: FlowMode[] = ['simple', 'standard', 'enterprise'];

function parseFlowMode(value: string | undefined): FlowMode {
  if (value && VALID_MODES.includes(value as FlowMode)) {
    return value as FlowMode;
  }
  return 'standard';
}

export interface InventoryConfigSection {
  inventory: {
    /** Flow engine mode: 'simple' | 'standard' | 'enterprise'. Default: 'standard'. */
    flowMode: FlowMode;
  };
}

const inventoryConfig: InventoryConfigSection = {
  inventory: {
    flowMode: parseFlowMode(process.env.FLOW_MODE),
  },
};

export default inventoryConfig;
