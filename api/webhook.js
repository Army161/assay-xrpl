/**
 * POST /api/webhook — Stripe events.
 *
 * The raw body is required for signature verification, so this route must NOT
 * have JSON body parsing applied. On Vercel that means `bodyParser: false`.
 *
 * Every event is verified before it is trusted. An unverified webhook endpoint
 * is an open door: anyone who knows the URL could otherwise grant themselves a
 * paid tier by POSTing a fake `checkout.session.completed`.
 */
import { verifyWebhook, stripe } from './_stripe.js';
import { send, fail } from './_lib.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return fail(res, 503, 'Webhook not configured', 'Set STRIPE_WEBHOOK_SECRET.');
  }

  const raw = await readRaw(req);
  const verdict = verifyWebhook(raw, req.headers['stripe-signature'], webhookSecret);
  if (!verdict.ok) {
    // 400 tells Stripe not to retry a request we will never accept.
    return fail(res, 400, `Webhook signature verification failed: ${verdict.reason}`);
  }

  let event;
  try { event = JSON.parse(raw); }
  catch { return fail(res, 400, 'Invalid JSON payload'); }

  try {
    await handleEvent(event);
  } catch (e) {
    // 500 asks Stripe to retry. Only use it for genuinely transient problems —
    // a permanent failure retried forever is noise.
    console.error(`webhook ${event.type} failed:`, e.message);
    return fail(res, 500, 'Handler error; Stripe will retry');
  }

  return send(res, 200, { received: true, type: event.type });
}

async function handleEvent(event) {
  const obj = event.data?.object || {};

  switch (event.type) {
    case 'checkout.session.completed': {
      // The key was minted at checkout and attached to subscription_data, so
      // normally nothing is needed here. This backfills the case where a
      // session was created outside our own /api/checkout (e.g. a payment link).
      const key = obj.metadata?.assay_key || obj.client_reference_id;
      const tier = obj.metadata?.assay_tier;
      if (obj.subscription && key) {
        const sub = await stripe(`/subscriptions/${obj.subscription}`);
        if (!sub.metadata?.assay_key) {
          await stripe(`/subscriptions/${obj.subscription}`, {
            method: 'POST',
            body: { metadata: { assay_key: key, assay_tier: tier || 'firm' } },
          });
        }
      }
      console.log(`provisioned key for session ${obj.id}`);
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Nothing to revoke by hand: tierForApiKey() reads subscription status
      // live, so a cancelled or past_due subscription stops working the moment
      // Stripe says so. Logged for visibility only.
      console.log(`subscription ${obj.id} -> ${obj.status}`);
      break;
    }

    case 'invoice.payment_failed':
      console.warn(`payment failed for subscription ${obj.subscription}`);
      break;

    default:
      break;   // Unhandled events are fine; acknowledge and move on.
  }
}

function readRaw(req) {
  return new Promise(resolve => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
