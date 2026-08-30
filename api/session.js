/**
 * GET /api/session?id=cs_... — surface the API key minted for a checkout session.
 *
 * Session IDs are unguessable and short-lived, which is what makes this safe
 * without an account system. We return only the key and tier, never customer
 * details.
 */
import { stripe, stripeConfigured } from './_stripe.js';
import { send, fail } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
  if (!stripeConfigured()) return fail(res, 503, 'Billing is not configured');

  const id = new URL(req.url, 'http://x').searchParams.get('id');
  if (!id || !id.startsWith('cs_')) return fail(res, 400, 'Missing or malformed session id');

  try {
    const session = await stripe(`/checkout/sessions/${encodeURIComponent(id)}`);
    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return fail(res, 409, 'Checkout is not complete yet', 'Wait a moment and refresh.');
    }
    return send(res, 200, {
      apiKey: session.metadata?.assay_key || session.client_reference_id || null,
      tier: session.metadata?.assay_tier || null,
    });
  } catch (e) {
    return fail(res, 502, `Could not read session: ${e.message}`);
  }
}
