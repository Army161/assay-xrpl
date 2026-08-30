/**
 * POST /api/checkout  { tier: "pro" }  ->  { url }
 *
 * Creates a Stripe Checkout Session and returns the hosted payment URL.
 * We never see or handle card details — Stripe's hosted page does that.
 */
import { stripe, stripeConfigured, priceForTier, newApiKey } from './_stripe.js';
import { send, fail } from './_lib.js';

const TIERS = ['desk', 'firm', 'enterprise'];

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed', 'POST a JSON body: { "tier": "pro" }');

  if (!stripeConfigured()) {
    return fail(res, 503, 'Billing is not configured',
      'Set STRIPE_SECRET_KEY and the STRIPE_PRICE_* variables. See docs /billing.');
  }

  let body = {};
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(await readBody(req) || '{}');
  } catch {
    return fail(res, 400, 'Invalid JSON body');
  }

  const tier = String(body.tier || '').toLowerCase();
  if (!TIERS.includes(tier)) {
    return fail(res, 400, `Unknown tier "${body.tier}"`, `Valid tiers: ${TIERS.join(', ')}`);
  }

  const price = priceForTier(tier);
  if (!price) {
    return fail(res, 503, `No Stripe price configured for "${tier}"`,
      `Set STRIPE_PRICE_${tier.toUpperCase()} to a Stripe price ID.`);
  }

  // Generated here rather than in the webhook so it can be attached to the
  // subscription at creation time — the webhook then has nothing to invent.
  const apiKey = newApiKey();
  const origin = process.env.PUBLIC_ORIGIN
    || (req.headers.origin || `https://${req.headers.host}`);

  try {
    const session = await stripe('/checkout/sessions', {
      method: 'POST',
      body: {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/#pricing`,
        allow_promotion_codes: true,
        client_reference_id: apiKey,
        subscription_data: {
          metadata: { assay_key: apiKey, assay_tier: tier },
        },
        metadata: { assay_key: apiKey, assay_tier: tier },
      },
      // Same tier requested twice in the same second should not create two sessions.
      idempotencyKey: `checkout_${tier}_${apiKey}`,
    });

    return send(res, 200, { url: session.url, tier, sessionId: session.id });
  } catch (e) {
    return fail(res, 502, `Could not create checkout session: ${e.message}`);
  }
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
