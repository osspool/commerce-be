#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

warn_count=0

ok() {
  printf 'OK: %s\n' "$1"
}

warn() {
  printf 'WARN: %s\n' "$1" >&2
  if [[ $# -gt 1 ]]; then
    printf '%s\n' "$2" >&2
  fi
  warn_count=$((warn_count + 1))
}

contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq "$pattern" "$ROOT_DIR/$file"
}

availability_file="src/resources/inventory/warehouse/availability.resource.ts"
if contains "$availability_file" "(req.query as Record<string, string>).branchId" \
  && ! contains "$availability_file" "resolveAuthorizedBranchId"; then
  warn \
    "Availability resource trusts caller-supplied branchId without auth-scope enforcement." \
    "$availability_file accepts branchId from query/body and builds Flow context directly instead of using resolveAuthorizedBranchId()."
else
  ok "Availability resource appears scope-bound."
fi

reservation_file="src/resources/inventory/warehouse/reservation.resource.ts"
if contains "$reservation_file" "const { branchId, ...input } = req.body" \
  && contains "$reservation_file" "buildFlowContext((branchId as string) || (user?.organizationId as string), user?.id)" \
  && ! contains "$reservation_file" "resolveAuthorizedBranchId"; then
  warn \
    "Reservation resource accepts branchId override without auth-scope enforcement." \
    "$reservation_file builds Flow context from request body branchId directly, allowing cross-branch reservation attempts."
else
  ok "Reservation resource appears scope-bound."
fi

vendor_bill_file="src/resources/accounting/vendor-bill/vendor-bill.resource.ts"
if contains "$vendor_bill_file" "accounting.repositories.reconciliations.getOpenItems({" \
  && ! contains "$vendor_bill_file" "organizationId"; then
  warn \
    "Vendor bill open-items route is not organization-scoped." \
    "$vendor_bill_file reads open A/P items without req.scope.organizationId filtering, so branch-tagged ledgers can leak across branches."
else
  ok "Vendor bill open-items route appears organization-scoped."
fi

customer_invoice_file="src/resources/accounting/customer-invoice/customer-invoice.resource.ts"
if contains "$customer_invoice_file" "accounting.repositories.reconciliations.getOpenItems({" \
  && ! contains "$customer_invoice_file" "organizationId"; then
  warn \
    "Customer invoice open-items route is not organization-scoped." \
    "$customer_invoice_file reads open A/R items without req.scope.organizationId filtering, so branch-tagged receivables can leak across branches."
else
  ok "Customer invoice open-items route appears organization-scoped."
fi

transfer_controller_file="src/resources/inventory/transfer/transfer.controller.ts"
transfer_service_file="src/resources/inventory/transfer/transfer.service.ts"
if ! contains "$transfer_controller_file" "resolveAuthorizedBranchId" \
  && contains "$transfer_service_file" "const { senderBranchId, receiverBranchId, items, documentType, remarks } = data;"; then
  warn \
    "Transfer creation is not visibly bound to the active branch scope." \
    "$transfer_controller_file passes caller payload straight into transferService.createTransfer(), and $transfer_service_file trusts senderBranchId/receiverBranchId from the body."
else
  ok "Transfer creation appears to enforce active branch scope."
fi

purchase_invoice_file="src/resources/inventory/purchase/purchase-invoice.service.ts"
if contains "$purchase_invoice_file" "supplierName: (purchase as Record<string, unknown>).supplierName as string | undefined"; then
  warn \
    "Purchase receipt event emits supplierName from a field that is not persisted on Purchase." \
    "$purchase_invoice_file emits notifyEvent.purchaseReceived() after reload/commit, but reads purchase.supplierName even though the purchase document stores supplier ObjectId rather than supplierName."
else
  ok "Purchase receipt event payload appears to be sourced from persisted fields."
fi

printf '\n'
if [[ $warn_count -gt 0 ]]; then
  printf 'Alignment audit completed with %d warning(s).\n' "$warn_count" >&2
  exit 1
fi

printf 'Alignment audit completed without warnings.\n'
