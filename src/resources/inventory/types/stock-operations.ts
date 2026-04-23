/**
 * Shared types for stock mutation operations.
 *
 * Used by StockService (commerce) and StockTransactionService (inventory).
 * Keeps the contract between order/POS/fulfillment and Flow MoveGroups type-safe.
 */

export interface StockOperationItem {
  productId: string;
  variantSku?: string | null;
  quantity: number;
  productName?: string;
  /**
   * Optional override for the physical bin a returned item lands in.
   * RMA / restock flows can route per-line to QC, restock, scrap, or
   * RTV bins. Falls back to the branch default `stock` location when
   * omitted. Mirrors the per-line override pattern on transfer +
   * purchase (Batch A-B).
   */
  destinationLocationId?: string;
}

export interface StockReference {
  model: string;
  id?: string | { toString(): string };
}

export interface StockMutationResultItem {
  productId: string;
  variantSku?: string;
  quantity: number;
}

export interface StockMutationResult {
  success: boolean;
  moveGroupIds: string[];
  error?: string;
  items: StockMutationResultItem[];
}
