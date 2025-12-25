/**
 * Manual Verification Script: Points Restoration on Cancel/Refund
 *
 * This script directly tests the order cancel/refund points restoration
 * functionality by simulating the complete flow.
 *
 * Run with: node tests/manual/verify-points-restoration.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import models
import Customer from '../../modules/customer/customer.model.js';
import Order from '../../modules/commerce/order/order.model.js';
import { ORDER_STATUS, PAYMENT_STATUS } from '../../modules/commerce/order/order.enums.js';
import orderRepository from '../../modules/commerce/order/order.repository.js';

async function verifyPointsRestoration() {
  try {
    console.log('🔧 Connecting to database...');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/ecommerce-test');
    console.log('✅ Connected to MongoDB\n');

    // Test 1: Cancel Order with Points Redemption
    console.log('═══════════════════════════════════════════');
    console.log('TEST 1: Cancel Order with Points Redemption');
    console.log('═══════════════════════════════════════════\n');

    // Create test customer with membership
    const testCustomer = await Customer.create({
      name: 'Points Test Customer',
      phone: `0171${Date.now().toString().slice(-7)}`,
      email: `points-test-${Date.now()}@example.com`,
      membership: {
        cardId: `TEST-${Date.now().toString().slice(-8)}`,
        isActive: true,
        enrolledAt: new Date(),
        points: {
          current: 500,
          lifetime: 500,
          redeemed: 0,
        },
        tier: 'Gold',
      },
    });

    console.log(`✓ Created test customer: ${testCustomer._id}`);
    console.log(`  Initial points: ${testCustomer.membership.points.current}`);
    console.log(`  Initial redeemed: ${testCustomer.membership.points.redeemed}\n`);

    // Create order with points redemption
    const testOrder = await Order.create({
      customer: testCustomer._id,
      customerName: testCustomer.name,
      customerPhone: testCustomer.phone,
      source: 'pos',
      status: ORDER_STATUS.DELIVERED,
      items: [{
        product: new mongoose.Types.ObjectId(),
        productName: 'Test Product',
        quantity: 1,
        price: 1000,
      }],
      subtotal: 1000,
      discountAmount: 60, // 50 tier + 10 redemption
      totalAmount: 940,
      currentPayment: {
        method: 'cash',
        amount: 94000, // in paisa
        status: PAYMENT_STATUS.VERIFIED,
      },
      membershipApplied: {
        cardId: testCustomer.membership.cardId,
        tier: 'Gold',
        pointsEarned: 15,
        pointsRedeemed: 100, // Redeemed 100 points
        pointsRedemptionDiscount: 10,
        tierDiscountApplied: 50,
        tierDiscountPercent: 5,
      },
    });

    console.log(`✓ Created test order: ${testOrder._id}`);
    console.log(`  Points redeemed: ${testOrder.membershipApplied.pointsRedeemed}\n`);

    // Manually update customer to reflect points deduction (simulating POS flow)
    await Customer.findByIdAndUpdate(testCustomer._id, {
      $inc: {
        'membership.points.current': -100,
        'membership.points.redeemed': 100,
      },
    });

    let customerAfterDeduction = await Customer.findById(testCustomer._id).lean();
    console.log('After simulated points deduction:');
    console.log(`  Current points: ${customerAfterDeduction.membership.points.current} (expected: 400)`);
    console.log(`  Redeemed: ${customerAfterDeduction.membership.points.redeemed} (expected: 100)\n`);

    // TEST: Cancel the order
    console.log('Cancelling order...');
    await orderRepository.update(testOrder._id, { status: ORDER_STATUS.CANCELLED });

    // Wait for async event processing
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify points were restored
    const customerAfterCancel = await Customer.findById(testCustomer._id).lean();
    console.log('\nAfter order cancellation:');
    console.log(`  Current points: ${customerAfterCancel.membership.points.current} (expected: 500 - restored!)`);
    console.log(`  Redeemed: ${customerAfterCancel.membership.points.redeemed} (expected: 0)\n`);

    if (customerAfterCancel.membership.points.current === 500 &&
        customerAfterCancel.membership.points.redeemed === 0) {
      console.log('✅ TEST 1 PASSED: Points correctly restored on cancellation\n');
    } else {
      console.error('❌ TEST 1 FAILED: Points not restored correctly');
      console.error(`   Expected: current=500, redeemed=0`);
      console.error(`   Actual: current=${customerAfterCancel.membership.points.current}, redeemed=${customerAfterCancel.membership.points.redeemed}\n`);
    }

    // Test 2: Refund Order with Points Redemption
    console.log('═══════════════════════════════════════════');
    console.log('TEST 2: Refund Order with Points Redemption');
    console.log('═══════════════════════════════════════════\n');

    // Reset customer points
    await Customer.findByIdAndUpdate(testCustomer._id, {
      $set: {
        'membership.points.current': 500,
        'membership.points.redeemed': 0,
      },
    });

    // Create another order with points redemption
    const refundOrder = await Order.create({
      customer: testCustomer._id,
      customerName: testCustomer.name,
      customerPhone: testCustomer.phone,
      source: 'pos',
      status: ORDER_STATUS.DELIVERED,
      items: [{
        product: new mongoose.Types.ObjectId(),
        productName: 'Test Product 2',
        quantity: 1,
        price: 1000,
      }],
      subtotal: 1000,
      discountAmount: 65,
      totalAmount: 935,
      currentPayment: {
        method: 'cash',
        amount: 93500,
        status: PAYMENT_STATUS.VERIFIED,
      },
      membershipApplied: {
        cardId: testCustomer.membership.cardId,
        tier: 'Gold',
        pointsEarned: 15,
        pointsRedeemed: 150, // Redeemed 150 points
        pointsRedemptionDiscount: 15,
        tierDiscountApplied: 50,
        tierDiscountPercent: 5,
      },
    });

    console.log(`✓ Created refund test order: ${refundOrder._id}`);
    console.log(`  Points redeemed: ${refundOrder.membershipApplied.pointsRedeemed}\n`);

    // Simulate points deduction
    await Customer.findByIdAndUpdate(testCustomer._id, {
      $inc: {
        'membership.points.current': -150,
        'membership.points.redeemed': 150,
      },
    });

    customerAfterDeduction = await Customer.findById(testCustomer._id).lean();
    console.log('After simulated points deduction:');
    console.log(`  Current points: ${customerAfterDeduction.membership.points.current} (expected: 350)`);
    console.log(`  Redeemed: ${customerAfterDeduction.membership.points.redeemed} (expected: 150)\n`);

    // TEST: Refund the order
    console.log('Refunding order...');
    await orderRepository.update(refundOrder._id, {
      'currentPayment.status': PAYMENT_STATUS.REFUNDED,
    });

    // Wait for async event processing
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verify points were restored
    const customerAfterRefund = await Customer.findById(testCustomer._id).lean();
    console.log('\nAfter order refund:');
    console.log(`  Current points: ${customerAfterRefund.membership.points.current} (expected: 500 - restored!)`);
    console.log(`  Redeemed: ${customerAfterRefund.membership.points.redeemed} (expected: 0)\n`);

    if (customerAfterRefund.membership.points.current === 500 &&
        customerAfterRefund.membership.points.redeemed === 0) {
      console.log('✅ TEST 2 PASSED: Points correctly restored on refund\n');
    } else {
      console.error('❌ TEST 2 FAILED: Points not restored correctly');
      console.error(`   Expected: current=500, redeemed=0`);
      console.error(`   Actual: current=${customerAfterRefund.membership.points.current}, redeemed=${customerAfterRefund.membership.points.redeemed}\n`);
    }

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    await Customer.findByIdAndDelete(testCustomer._id);
    await Order.deleteMany({ customer: testCustomer._id });
    console.log('✓ Cleanup complete\n');

    console.log('═══════════════════════════════════════════');
    console.log('VERIFICATION COMPLETE');
    console.log('═══════════════════════════════════════════');

  } catch (error) {
    console.error('\n❌ ERROR during verification:');
    console.error(error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Database connection closed');
  }
}

// Run verification
verifyPointsRestoration();
