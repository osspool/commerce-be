/**
 * Session Helpers
 *
 * Simple utility functions for customer session management
 * No classes, no complexity - just pure functions
 * Similar to Next.js cookie helpers
 */

const COOKIE_NAME = 'customer_session';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Get customer from session cookie
 */
export function getCustomerSession(request) {
  try {
    const value = request.cookies[COOKIE_NAME];
    if (!value) return null;

    const session = typeof value === 'string' ? JSON.parse(value) : value;

    // Check expiration
    if (session.ts && (Date.now() - session.ts > MAX_AGE)) {
      return null;
    }

    return session;
  } catch (error) {
    return null;
  }
}

/**
 * Set customer in session cookie
 */
export function setCustomerSession(reply, customer) {
  if (!customer?._id) return;

  const session = {
    customerId: String(customer._id),
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    ts: Date.now(),
  };

  reply.setCookie(COOKIE_NAME, JSON.stringify(session), {
    signed: true,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE,
    path: '/',
  });

  return session;
}

/**
 * Clear customer session
 */
export function clearCustomerSession(reply) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}
