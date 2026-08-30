/**
 * Issuer analysis: supply, holders, concentration, and compliance posture for
 * a token-issuing XRPL account.
 */
import { rpc, paginate, decodeCurrency, decodeAccountFlags, XrplError } from './client.mjs';
import { concentration, gini } from '../scoring/concentration.mjs';
import { posture } from '../scoring/posture.mjs';

/**
 * Authoritative issued supply, straight from the issuer's obligations.
 * This is the denominator every concentration figure divides by, so it must
 * never be inferred from a holder sample.
 */
export async function supply(account) {
  const g = await rpc('gateway_balances', { account, ledger_index: 'validated' });
  const obligations = g?.obligations || {};
  return Object.entries(obligations).map(([code, amount]) => ({
    currency: decodeCurrency(code),
    currencyHex: code,
    issued: Number(amount),
  })).sort((a, b) => b.issued - a.issued);
}

/** Account settings and decoded flags. */
export async function account(accountId) {
  const r = await rpc('account_info', { account: accountId, ledger_index: 'validated' });
  const d = r?.account_data || {};
  return {
    account: accountId,
    xrpBalance: Number(d.Balance || 0) / 1e6,
    flagsRaw: d.Flags,
    flags: decodeAccountFlags(d.Flags),
    domain: d.Domain ? hexToUtf8(d.Domain) : null,
    sequence: d.Sequence,
    ownerCount: d.OwnerCount,
    emailHash: d.EmailHash || null,
    transferRate: d.TransferRate ? +((d.TransferRate / 1e9 - 1) * 100).toFixed(4) : 0,
    tickSize: d.TickSize ?? null,
  };
}

/**
 * Holder balances for one currency.
 *
 * Trustline balances are signed from the ISSUER's perspective: an issuer's
 * account_lines shows what it owes as negative. We take absolute value, which
 * is the amount the counterparty holds.
 */
export async function holders(accountId, currencyHex, { maxPages = 20, onPage } = {}) {
  const { items, pages, complete } = await paginate(
    'account_lines',
    { account: accountId, ledger_index: 'validated', limit: 400 },
    { key: 'lines', maxPages, onPage }
  );

  const matching = items.filter(l => l.currency === currencyHex);
  const balances = matching
    .map(l => ({ account: l.account, balance: Math.abs(Number(l.balance)) }))
    .filter(h => Number.isFinite(h.balance) && h.balance > 0)
    .sort((a, b) => b.balance - a.balance);

  return {
    holders: balances,
    trustlinesScanned: items.length,
    pagesFetched: pages,
    complete,
  };
}

/**
 * Does this issuer use the ledger-native KYC primitives?
 * Credentials (XLS-70) and Permissioned Domains (XLS-80) are both enabled on
 * mainnet; using them is the strongest available on-ledger signal that an
 * issuer runs a gated holder base.
 */
export async function institutionalPrimitives(accountId) {
  const probe = async type => {
    try {
      const r = await rpc('account_objects', {
        account: accountId, type, ledger_index: 'validated', limit: 10,
      });
      return (r?.account_objects || []).length;
    } catch (e) {
      // An unsupported object type is a server capability gap, not a finding.
      if (e instanceof XrplError) return null;
      throw e;
    }
  };
  const [credentials, permissionedDomain, mptIssuance] = await Promise.all([
    probe('credential'), probe('permissioned_domain'), probe('mpt_issuance'),
  ]);
  return { credentials, permissionedDomain, mptIssuance };
}

/**
 * Full issuer report. `currency` is the human symbol (e.g. "RLUSD"); we resolve
 * it against actual obligations rather than trusting the caller's spelling.
 */
export async function analyse(accountId, { currency, maxPages = 20, onPage } = {}) {
  const [acct, supplies, primitives] = await Promise.all([
    account(accountId),
    supply(accountId),
    institutionalPrimitives(accountId),
  ]);

  if (!supplies.length) {
    return {
      account: accountId,
      observedAt: new Date().toISOString(),
      issuer: acct,
      supplies: [],
      error: 'This account has no outstanding obligations — it does not currently issue any token.',
    };
  }

  const target = currency
    ? supplies.find(s => s.currency.toUpperCase() === currency.toUpperCase())
    : supplies[0];

  if (!target) {
    return {
      account: accountId,
      observedAt: new Date().toISOString(),
      issuer: acct,
      supplies,
      error: `Issuer does not issue "${currency}". Available: ${supplies.map(s => s.currency).join(', ')}`,
    };
  }

  const h = await holders(accountId, target.currencyHex, { maxPages, onPage });
  const balances = h.holders.map(x => x.balance);

  const conc = concentration(balances, target.issued, {
    complete: h.complete,
    pagesFetched: h.pagesFetched,
  });

  const post = posture(acct.flags, {
    domain: acct.domain,
    hasCredentials: primitives.credentials,
    hasPermissionedDomain: primitives.permissionedDomain,
  });

  return {
    account: accountId,
    observedAt: new Date().toISOString(),
    issuer: acct,
    asset: {
      currency: target.currency,
      currencyHex: target.currencyHex,
      issuedSupply: target.issued,
      transferFeePct: acct.transferRate,
    },
    supplies,
    concentration: conc,
    giniObserved: gini(balances),
    topHolders: h.holders.slice(0, 25).map(x => ({
      account: x.account,
      balance: x.balance,
      pctOfSupply: +(x.balance / target.issued * 100).toFixed(4),
    })),
    posture: post,
    primitives,
    sampling: {
      trustlinesScanned: h.trustlinesScanned,
      holdersWithBalance: h.holders.length,
      pagesFetched: h.pagesFetched,
      complete: h.complete,
      note: h.complete
        ? 'Full holder set retrieved.'
        : 'Holder set truncated at the page ceiling. Concentration figures are lower bounds.',
    },
  };
}

function hexToUtf8(hex) {
  try { return Buffer.from(hex, 'hex').toString('utf8'); }
  catch { return hex; }
}
