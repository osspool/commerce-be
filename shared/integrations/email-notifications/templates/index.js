/**
 * Email Templates for Ecommerce
 * 
 * Events:
 * - purchase.created → New order (admin)
 * - payment.verified → Order confirmed (admin + customer)
 * - payment.refunded → Refund processed (admin + customer)
 */

/**
 * Format amount from smallest unit (paisa) to display (BDT)
 */
function formatAmount(amount, currency = 'BDT') {
  const value = (amount / 100).toLocaleString('en-BD', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `${currency} ${value}`;
}

/**
 * Format date for Bangladesh
 */
function formatDate(date) {
  return new Date(date).toLocaleDateString('en-BD', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Format order items as HTML list
 */
function formatItemsHtml(items = []) {
  if (!items.length) return '<p>No items</p>';
  
  return `
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background-color: #f8f9fa;">
          <th style="padding: 10px; text-align: left; border-bottom: 2px solid #dee2e6;">Product</th>
          <th style="padding: 10px; text-align: center; border-bottom: 2px solid #dee2e6;">Qty</th>
          <th style="padding: 10px; text-align: right; border-bottom: 2px solid #dee2e6;">Price</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(item => `
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #dee2e6;">${item.productName}</td>
            <td style="padding: 10px; text-align: center; border-bottom: 1px solid #dee2e6;">${item.quantity}</td>
            <td style="padding: 10px; text-align: right; border-bottom: 1px solid #dee2e6;">${formatAmount(item.price * item.quantity)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

/**
 * Format order items as text
 */
function formatItemsText(items = []) {
  if (!items.length) return 'No items';
  return items.map(item => 
    `- ${item.productName} x${item.quantity} = ${formatAmount(item.price * item.quantity)}`
  ).join('\n');
}

/**
 * Format delivery address
 */
function formatAddress(address) {
  if (!address) return 'Not provided';
  const parts = [
    address.addressLine1,
    address.addressLine2,
    address.city,
    address.state,
    address.postalCode,
    address.country,
  ].filter(Boolean);
  return parts.join(', ');
}

const templates = {
  // ============ NEW ORDER (ADMIN) ============
  'purchase.created': (data) => ({
    subject: `🛒 New Order #${data.orderId?.slice(-8)} - ${formatAmount(data.amount)}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center;">
          <h1 style="color: white; margin: 0;">🛒 New Order Received</h1>
        </div>
        
        <div style="padding: 30px;">
          <div style="background-color: #fef3c7; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #f59e0b;">
            <p style="margin: 0; font-weight: bold;">⏳ Payment Pending - Manual Verification Required</p>
          </div>

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-top: 0; color: #333;">Customer Details</h3>
            <p><strong>Name:</strong> ${data.customerName}</p>
            ${data.customerEmail ? `<p><strong>Email:</strong> ${data.customerEmail}</p>` : ''}
            ${data.customerPhone ? `<p><strong>Phone:</strong> ${data.customerPhone}</p>` : ''}
          </div>

          <div style="margin-bottom: 20px;">
            <h3 style="color: #333;">Order Items</h3>
            ${formatItemsHtml(data.items)}
          </div>

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
            <h3 style="margin-top: 0; color: #333;">Order Summary</h3>
            <p><strong>Order ID:</strong> ${data.orderId}</p>
            <p><strong>Subtotal:</strong> ${formatAmount(data.subtotal * 100)}</p>
            ${data.discount > 0 ? `<p><strong>Discount:</strong> -${formatAmount(data.discount * 100)}</p>` : ''}
            ${data.delivery > 0 ? `<p><strong>Delivery:</strong> ${formatAmount(data.delivery * 100)}</p>` : ''}
            <p style="font-size: 18px; font-weight: bold; color: #16a34a;"><strong>Total:</strong> ${formatAmount(data.amount)}</p>
            <p><strong>Payment Method:</strong> ${data.paymentMethod}</p>
          </div>

          ${data.deliveryAddress ? `
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
            <h3 style="margin-top: 0; color: #333;">Delivery Address</h3>
            <p>${formatAddress(data.deliveryAddress)}</p>
            ${data.deliveryAddress.phone ? `<p><strong>Phone:</strong> ${data.deliveryAddress.phone}</p>` : ''}
          </div>
          ` : ''}
        </div>

        <div style="background-color: #f1f5f9; padding: 20px; text-align: center;">
          <p style="margin: 0; color: #64748b; font-size: 12px;">
            This is an automated notification. Order ID: ${data.orderId}
          </p>
        </div>
      </div>
    `,
    text: `New Order Received\n\nOrder ID: ${data.orderId}\nStatus: Payment Pending\n\nCustomer: ${data.customerName}\n${data.customerEmail ? `Email: ${data.customerEmail}\n` : ''}${data.customerPhone ? `Phone: ${data.customerPhone}\n` : ''}\n\nItems:\n${formatItemsText(data.items)}\n\nSubtotal: ${formatAmount(data.subtotal * 100)}\n${data.discount > 0 ? `Discount: -${formatAmount(data.discount * 100)}\n` : ''}${data.delivery > 0 ? `Delivery: ${formatAmount(data.delivery * 100)}\n` : ''}Total: ${formatAmount(data.amount)}\nPayment Method: ${data.paymentMethod}\n\n${data.deliveryAddress ? `Delivery Address: ${formatAddress(data.deliveryAddress)}` : ''}`
  }),

  // ============ PAYMENT VERIFIED (ADMIN) ============
  'payment.verified': (data) => {
    // Admin notification
    if (data.isAdminNotification) {
      return {
        subject: `✅ Payment Verified - Order #${data.orderId?.slice(-8)}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center;">
              <h1 style="color: white; margin: 0;">✅ Payment Verified</h1>
            </div>
            
            <div style="padding: 30px;">
              <div style="background-color: #d1fae5; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #10b981;">
                <p style="margin: 0; font-weight: bold;">Payment has been verified. Order ready for processing.</p>
              </div>

              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                <h3 style="margin-top: 0;">Payment Details</h3>
                <p><strong>Order ID:</strong> ${data.orderId}</p>
                <p><strong>Amount:</strong> ${formatAmount(data.amount)}</p>
                <p><strong>Method:</strong> ${data.paymentMethod}</p>
                <p><strong>Verified At:</strong> ${formatDate(data.verifiedAt)}</p>
                <p><strong>Transaction ID:</strong> ${data.transactionId}</p>
              </div>

              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
                <h3 style="margin-top: 0;">Customer</h3>
                <p><strong>Name:</strong> ${data.customerName}</p>
                ${data.customerEmail ? `<p><strong>Email:</strong> ${data.customerEmail}</p>` : ''}
                ${data.customerPhone ? `<p><strong>Phone:</strong> ${data.customerPhone}</p>` : ''}
              </div>
            </div>
          </div>
        `,
        text: `Payment Verified\n\nOrder ID: ${data.orderId}\nAmount: ${formatAmount(data.amount)}\nMethod: ${data.paymentMethod}\nVerified At: ${formatDate(data.verifiedAt)}\n\nCustomer: ${data.customerName}\n${data.customerEmail ? `Email: ${data.customerEmail}` : ''}`
      };
    }

    // Customer notification
    return {
      subject: `✅ Order Confirmed - Your payment has been received`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
          <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0;">✅ Order Confirmed!</h1>
          </div>
          
          <div style="padding: 30px;">
            <p style="font-size: 16px;">Dear ${data.customerName},</p>
            <p>Thank you for your order! Your payment has been verified and your order is now being processed.</p>

            <div style="background-color: #d1fae5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #065f46;">Order Summary</h3>
              <p><strong>Order ID:</strong> ${data.orderId?.slice(-8)}</p>
              <p><strong>Total Paid:</strong> ${formatAmount(data.amount)}</p>
              <p><strong>Payment Method:</strong> ${data.paymentMethod}</p>
            </div>

            <div style="margin: 20px 0;">
              <h3>Items Ordered</h3>
              ${formatItemsHtml(data.items)}
            </div>

            <p>We'll notify you when your order ships.</p>

            <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
              If you have any questions, please contact us.
            </p>
          </div>
        </div>
      `,
      text: `Order Confirmed!\n\nDear ${data.customerName},\n\nThank you for your order! Your payment has been verified.\n\nOrder ID: ${data.orderId?.slice(-8)}\nTotal: ${formatAmount(data.amount)}\nPayment Method: ${data.paymentMethod}\n\nItems:\n${formatItemsText(data.items)}\n\nWe'll notify you when your order ships.`
    };
  },

  // ============ REFUND PROCESSED ============
  'payment.refunded': (data) => {
    // Admin notification
    if (data.isAdminNotification) {
      return {
        subject: `💸 Refund Processed - Order #${data.orderId?.slice(-8)} - ${formatAmount(data.refundAmount)}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
            <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; text-align: center;">
              <h1 style="color: white; margin: 0;">💸 Refund Processed</h1>
            </div>
            
            <div style="padding: 30px;">
              <div style="background-color: #fef3c7; padding: 15px; border-radius: 8px; margin-bottom: 20px; border-left: 4px solid #f59e0b;">
                <p style="margin: 0;"><strong>${data.isPartialRefund ? 'Partial' : 'Full'} refund processed</strong></p>
              </div>

              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                <h3 style="margin-top: 0;">Refund Details</h3>
                <p><strong>Order ID:</strong> ${data.orderId}</p>
                <p><strong>Refund Amount:</strong> ${formatAmount(data.refundAmount)}</p>
                <p><strong>Reason:</strong> ${data.reason}</p>
                <p><strong>Refund Transaction:</strong> ${data.refundTransactionId}</p>
              </div>

              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
                <h3 style="margin-top: 0;">Customer</h3>
                <p><strong>Name:</strong> ${data.customerName}</p>
                ${data.customerEmail ? `<p><strong>Email:</strong> ${data.customerEmail}</p>` : ''}
                ${data.customerPhone ? `<p><strong>Phone:</strong> ${data.customerPhone}</p>` : ''}
              </div>
            </div>
          </div>
        `,
        text: `Refund Processed\n\nOrder ID: ${data.orderId}\nRefund Amount: ${formatAmount(data.refundAmount)}\nReason: ${data.reason}\n\nCustomer: ${data.customerName}`
      };
    }

    // Customer notification
    return {
      subject: `💸 Refund Processed - ${formatAmount(data.refundAmount)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #fff;">
          <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0;">💸 Refund Processed</h1>
          </div>
          
          <div style="padding: 30px;">
            <p style="font-size: 16px;">Dear ${data.customerName},</p>
            <p>Your refund has been processed successfully.</p>

            <div style="background-color: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #92400e;">Refund Details</h3>
              <p><strong>Amount:</strong> ${formatAmount(data.refundAmount)}</p>
              <p><strong>Reason:</strong> ${data.reason}</p>
            </div>

            <p>The refund will be credited to your original payment method within 5-7 business days.</p>

            <p style="color: #64748b; font-size: 14px; margin-top: 30px;">
              If you have any questions, please contact us.
            </p>
          </div>
        </div>
      `,
      text: `Refund Processed\n\nDear ${data.customerName},\n\nYour refund has been processed.\n\nAmount: ${formatAmount(data.refundAmount)}\nReason: ${data.reason}\n\nThe refund will be credited within 5-7 business days.`
    };
  },
};

/**
 * Render email template
 */
export function renderTemplate(templateName, data) {
  const template = templates[templateName];
  if (!template) {
    console.warn(`[Templates] Template not found: ${templateName}`);
    // Return generic fallback
    return {
      subject: `Notification: ${templateName}`,
      html: `<p>Event: ${templateName}</p><pre>${JSON.stringify(data, null, 2)}</pre>`,
      text: `Event: ${templateName}\n${JSON.stringify(data, null, 2)}`,
    };
  }
  return template(data);
}
