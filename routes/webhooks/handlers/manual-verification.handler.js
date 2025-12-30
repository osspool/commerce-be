import { getRevenue } from "#shared/revenue/revenue.plugin.js";
import Order from "#modules/sales/orders/order.model.js";
import { PAYMENT_STATUS } from "#modules/sales/orders/order.enums.js";

/**
 * Manual Payment Verification Handler
 * Superadmin verifies manual payments (cash, bank transfer, bkash, nagad)
 * 
 * Flow:
 * 1. Customer places order → Transaction created with status: 'pending'
 * 2. Customer pays via bkash/nagad/bank/cash
 * 3. Admin verifies payment via this endpoint
 * 4. revenue.payments.verify() updates transaction to 'verified'
 * 5. 'payment.verified' hook fires
 * 6. Hook updates Order: paymentStatus = 'completed', status = 'confirmed'
 */
export async function verifyManualPayment(request, reply) {
  const { transactionId, notes } = request.body;

  try {
  const revenue = getRevenue();

    // Get verifiedBy from authenticated user
    const verifiedBy = request.user?._id || request.user?.id;
    if (!verifiedBy) {
      return reply.code(401).send({
        success: false,
        message: 'User authentication required for verification',
      });
    }

    // Verify payment via library
    const result = await revenue.payments.verify(transactionId, {
      verifiedBy,
      metadata: notes ? { verificationNotes: notes } : undefined,
    });

    // Extract entity info from transaction for response
    const entityInfo = result.transaction.referenceModel && result.transaction.referenceId
      ? {
          referenceModel: result.transaction.referenceModel,
          referenceId: result.transaction.referenceId.toString(),
        }
      : null;

    // Log verification with full context
    request.log.info({
      transactionId,
      verifiedBy: verifiedBy.toString(),
      status: result.transaction.status,
      amount: result.transaction.amount,
      category: result.transaction.category,
      organizationId: result.transaction.organizationId?.toString(),
      entity: entityInfo,
      notes,
    }, 'OK: Manual payment verified');

    return reply.code(200).send({
      success: true,
      message: 'Payment verified successfully',
      data: {
        transactionId: result.transaction._id.toString(),
        status: result.transaction.status,
        amount: result.transaction.amount,
        category: result.transaction.category,
        verifiedAt: result.transaction.verifiedAt,
        verifiedBy: result.transaction.verifiedBy?.toString(),
        entity: entityInfo,
      },
    });
  } catch (error) {
    // Map error types to HTTP status codes
    const statusCode = error.name === 'TransactionNotFoundError' ? 404
                     : error.name === 'AlreadyVerifiedError' ? 409
                     : error.name === 'PaymentVerificationError' ? 400
                     : 500;

    // Log error with full context
    request.log.error({
      transactionId,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
      statusCode,
    }, 'ERROR: Manual verification failed');

    return reply.code(statusCode).send({
      success: false,
      message: error.message,
      error: error.name,
    });
  }
}

/**
 * Manual Payment Rejection Handler
 * Superadmin rejects manual payments (invalid reference, fraud, etc.)
 * 
 * Flow:
 * 1. Customer claims payment but admin finds issue
 * 2. Admin rejects payment via this endpoint
 * 3. Transaction status → 'failed', reason recorded
 * 4. Order payment status → 'failed'
 */
export async function rejectManualPayment(request, reply) {
  const { transactionId, reason } = request.body;

  try {
    const revenue = getRevenue();

    const rejectedBy = request.user?._id || request.user?.id;
    if (!rejectedBy) {
      return reply.code(401).send({
        success: false,
        message: 'User authentication required for rejection',
      });
    }

    // Get transaction first to find linked order
    const transaction = await revenue.payments.getTransaction(transactionId);
    if (!transaction) {
      return reply.code(404).send({
        success: false,
        message: 'Transaction not found',
        error: 'TransactionNotFoundError',
      });
    }

    if (transaction.status === 'verified') {
      return reply.code(409).send({
        success: false,
        message: 'Cannot reject an already verified payment',
        error: 'AlreadyVerifiedError',
      });
    }

    if (transaction.status === 'failed') {
      return reply.code(409).send({
        success: false,
        message: 'Payment already rejected',
        error: 'AlreadyRejectedError',
      });
    }

    // Update transaction to failed
    transaction.status = 'failed';
    transaction.failureReason = reason;
    transaction.failedAt = new Date();
    await transaction.save();

    // Update linked Order if exists
    if (transaction.referenceModel === 'Order' && transaction.referenceId) {
      const order = await Order.findById(transaction.referenceId);
      if (order) {
        order.currentPayment.status = PAYMENT_STATUS.FAILED;
        
        if (order.addTimelineEvent) {
          order.addTimelineEvent(
            'payment.rejected',
            `Payment rejected: ${reason}`,
            request,
            {
              transactionId: transaction._id.toString(),
              reason,
              rejectedBy: rejectedBy.toString(),
            }
          );
        }
        
        await order.save();
      }
    }

    request.log.info({
      transactionId,
      rejectedBy: rejectedBy.toString(),
      reason,
      referenceModel: transaction.referenceModel,
      referenceId: transaction.referenceId?.toString(),
    }, 'OK: Manual payment rejected');

    return reply.code(200).send({
      success: true,
      message: 'Payment rejected',
      data: {
        transactionId: transaction._id.toString(),
        status: 'failed',
        failedAt: transaction.failedAt,
        failureReason: reason,
      },
    });
  } catch (error) {
    request.log.error({
      transactionId,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    }, 'ERROR: Manual rejection failed');

    return reply.code(500).send({
      success: false,
      message: error.message,
      error: error.name || 'PaymentRejectionError',
    });
  }
}
