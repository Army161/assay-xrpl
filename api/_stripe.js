/**
 * Stripe integration — no SDK, no database.
 *
 * Two deliberate choices worth understanding before editing:
 *
 * 1. NO SDK. Stripe's REST API is form-encoded HTTP and webhook signatures are
 *    HMAC-SHA256, both native to Node. The only runtime dependency in this
 *    project is the Anthropic SDK, used by the analyst endpoint alone.
 *
 * 2. NO DATABASE. API keys live in Stripe subscription metadata and tiers
 *    resolve against Stripe live. Stripe is already the source of truth for
 *    "is this person paying"; duplicating that into a database creates a second
 *    thing to keep in sync and get wrong. A cancelled or past_due subscription
 *    stops working immediately, with no revocation job to forget to run.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const API = 'https://api.stripe.com/v1';

const secret = () => process.env.STRIPE_SECRET_KEY || '';
export const stripeConfigured = () => Boolean(secret());

/** Stripe wants application/x-www-form-urlencoded, including nested keys. */
function encode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) encode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) =>
      typeof item === 'object' ? encode(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, item));
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(path, { method = 'GET', body, idempotencyKey } = {}) {
  if (!stripeConfigured()) throw new Error('STRIPE_SECRET_KEY is not set');
  const headers = {
    Authorization: `Bearer ${secret()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? encode(body).toString() : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${json?.error?.message || 'unknown error'}`);
  return json;
}

/**
 * Verify a webhook signature. Constant-time, with replay protection.
 * Never trust an unverified webhook: anyone who learns the URL could otherwise
 * grant themselves a paid tier by POSTing a fake checkout.session.completed.
 */
export function verifyWebhook(rawBody, signatureHeader, webhookSecret, toleranceSec = 300) {
  if (!signatureHeader || !webhookSecret) return { ok: false, reason: 'missing signature or secret' };

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.split('=').map(s => s.trim()))
  );
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return { ok: false, reason: 'malformed signature header' };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > toleranceSec) return { ok: false, reason: `timestamp outside tolerance (${age}s)` };

  const expected = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };

  return { ok: true };
}

/** Prefixed so keys are obvious in logs and greppable in support tickets. */
export const newApiKey = () => `assay_${randomBytes(24).toString('base64url')}`;

/**
 * Map a Stripe price ID to a tier.
 *
 * Built by filtering rather than with a placeholder key: an unset env var must
 * contribute NO entry. A shared sentinel would let two unconfigured tiers
 * collide on one map key, and the survivor would silently grant its tier to
 * whichever price happened to match.
 */
export function tierForPrice(priceId) {
  if (!priceId) return null;
  const entries = [
    [process.env.STRIPE_PRICE_DESK, 'desk'],
    [process.env.STRIPE_PRICE_FIRM, 'firm'],
    [process.env.STRIPE_PRICE_ENTERPRISE, 'enterprise'],
  ].filter(([id]) => Boolean(id));
  return Object.fromEntries(entries)[priceId] || null;
}

export function priceForTier(tier) {
  return {
    desk: process.env.STRIPE_PRICE_DESK,
    firm: process.env.STRIPE_PRICE_FIRM,
    enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
  }[tier] || null;
}

/**
 * Look up a tier by API key, using Stripe as the store.
 * Returns null for unknown or inactive keys — callers degrade to free.
 */
export async function tierForApiKey(key) {
  if (!key || !stripeConfigured()) return null;
  try {
    const found = await stripe(
      `/subscriptions/search?query=${encodeURIComponent(`metadata['assay_key']:'${key}'`)}&limit=1`
    );
    const sub = found?.data?.[0];
    if (!sub) return null;
    // trialing counts; past_due and canceled do not.
    if (!['active', 'trialing'].includes(sub.status)) return null;
    return sub.metadata?.assay_tier || tierForPrice(sub.items?.data?.[0]?.price?.id);
  } catch {
    return null;   // Stripe being down must never break a data request.
  }
}
