import type { FlowMode } from '@classytic/flow';

type ValuationMethod = 'wac' | 'fifo' | 'fefo';

const VALID_MODES: FlowMode[] = ['simple', 'standard', 'enterprise'];
const VALID_VALUATION_METHODS: ValuationMethod[] = ['wac', 'fifo', 'fefo'];

function parseFlowMode(value: string | undefined): FlowMode {
  if (value && VALID_MODES.includes(value as FlowMode)) {
    return value as FlowMode;
  }
  return 'standard';
}

function parseValuationMethod(value: string | undefined): ValuationMethod {
  if (value && VALID_VALUATION_METHODS.includes(value as ValuationMethod)) {
    return value as ValuationMethod;
  }
  return 'fifo';
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  return value === 'true' || value === '1';
}

export interface InventoryConfigSection {
  inventory: {
    /** Flow engine mode: 'simple' | 'standard' | 'enterprise'. Default: 'standard'. */
    flowMode: FlowMode;
    /** Inventory valuation method: 'wac' | 'fifo' | 'fefo'. Default: 'fifo'. */
    valuationMethod: ValuationMethod;
    /** Enable quality inspection subsystem (enterprise only). */
    qualityEnabled: boolean;
    /** Enable task/scanner execution primitives (enterprise only). */
    tasksEnabled: boolean;
    /** Enable dispatch/carrier/dock management (enterprise only). */
    dispatchEnabled: boolean;
    /** Enable RFID/voice/offline sync (enterprise only). */
    rfidEnabled: boolean;
  };
}

const flowMode = parseFlowMode(process.env.FLOW_MODE);
const enterpriseDefault = flowMode === 'enterprise';

const inventoryConfig: InventoryConfigSection = {
  inventory: {
    flowMode,
    valuationMethod: parseValuationMethod(process.env.FLOW_VALUATION_METHOD),
    qualityEnabled: parseBool(process.env.FLOW_QUALITY, enterpriseDefault),
    tasksEnabled: parseBool(process.env.FLOW_TASKS, enterpriseDefault),
    dispatchEnabled: parseBool(process.env.FLOW_DISPATCH, enterpriseDefault),
    rfidEnabled: parseBool(process.env.FLOW_RFID, enterpriseDefault),
  },
};

export default inventoryConfig;
