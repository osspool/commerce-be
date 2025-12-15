/**
 * Stripe Configuration
 * Stripe payment gateway settings for consultation fee payments
 */

import { warnIfMissing } from '../utils.js';

// Get the secret key (trim whitespace if present)
const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

warnIfMissing('STRIPE_WEBHOOK_SECRET');

export default {
  stripe: {
    // API Keys
    secretKey: secretKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim(),

    // Checkout URLs
    successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/booking/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/booking/cancel',

    // Optional settings
    mode: process.env.STRIPE_MODE || 'payment', // 'payment' or 'subscription'

    // Enabled flag
    enabled: Boolean(secretKey),
  },
};
