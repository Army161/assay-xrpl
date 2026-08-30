/**
 * Known issuer registry.
 *
 * Every address here was confirmed against mainnet `gateway_balances` during
 * development — none are copied from a blog post. `verifiedAt` records when.
 * Anything unverified does not belong in this file; the API accepts arbitrary
 * addresses anyway, so there is no reason to guess.
 */

export const ISSUERS = [
  {
    id: 'rlusd',
    name: 'Ripple USD (RLUSD)',
    operator: 'Ripple',
    account: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
    primaryCurrency: 'RLUSD',
    category: 'stablecoin',
    note: 'Institutional USD stablecoin, US Treasury backed. Subject to reserve-attestation regimes.',
    verifiedAt: '2026-08-30',
  },
  {
    id: 'bitstamp',
    name: 'Bitstamp',
    operator: 'Bitstamp',
    account: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B',
    primaryCurrency: 'USD',
    category: 'exchange-gateway',
    note: 'Multi-currency exchange gateway. Issues USD, EUR, GBP, JPY, CHF, AUD, BTC, ETH as IOUs.',
    verifiedAt: '2026-08-30',
  },
  {
    id: 'gatehub',
    name: 'GateHub',
    operator: 'GateHub',
    account: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq',
    primaryCurrency: 'USD',
    category: 'exchange-gateway',
    note: 'Gateway issuing USD and EUR IOUs.',
    verifiedAt: '2026-08-30',
  },
];

export const byId = id => ISSUERS.find(i => i.id === id) || null;
export const byAccount = a => ISSUERS.find(i => i.account === a) || null;
export const ISSUER_IDS = ISSUERS.map(i => i.id);

/** An r-address is 25–35 chars, base58, starting with r. Cheap guard before we spend an RPC call. */
export const looksLikeAddress = s => /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(String(s || ''));

/**
 * Resolve a user-supplied identifier to an account.
 * Accepts a registry id ("rlusd") or a raw r-address.
 */
export function resolve(input) {
  const known = byId(String(input || '').toLowerCase());
  if (known) return { account: known.account, meta: known };
  if (looksLikeAddress(input)) return { account: input, meta: byAccount(input) };
  return null;
}
