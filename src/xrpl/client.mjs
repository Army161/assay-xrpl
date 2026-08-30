/**
 * XRPL client. Zero dependencies — Node's fetch and nothing else.
 *
 * Public XRPL endpoints are free but throttle hard and occasionally return
 * plain-text rate-limit notices instead of JSON. Every call rotates endpoints
 * on failure and surfaces the real reason when it gives up, because a silent
 * null here becomes a wrong number on a compliance dashboard.
 */

export const ENDPOINTS = [
  'https://xrplcluster.com/',
  'https://s2.ripple.com:51234/',
  'https://s1.ripple.com:51234/',
];

export class XrplError extends Error {
  constructor(message, { method, code } = {}) {
    super(message);
    this.name = 'XrplError';
    this.method = method;
    this.code = code;
  }
}

/**
 * Call a rippled JSON-RPC method.
 * Throws XrplError on a ledger-level error so callers cannot mistake an
 * error object for data.
 */
export async function rpc(method, params = {}, { endpoints = ENDPOINTS, timeout = 25000, attempts = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const url = endpoints[i % endpoints.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params: [params] }),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error(`non-JSON from ${url}: ${text.slice(0, 100)}`); }

      const result = json?.result;
      if (result?.error) {
        // actNotFound and friends are real answers, not transport failures —
        // do not burn retries on them.
        throw new XrplError(result.error_message || result.error, { method, code: result.error });
      }
      if (!result) throw new Error('response had no result');
      return result;
    } catch (e) {
      if (e instanceof XrplError) throw e;
      lastErr = e;
      if (i < attempts - 1) await sleep(300 * (i + 1));
    }
  }
  throw new XrplError(`${method} failed after ${attempts} attempts: ${lastErr?.message}`, { method });
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Follow rippled's `marker` pagination.
 *
 * `maxPages` is a real ceiling, not a formality: a large issuer has hundreds of
 * thousands of trustlines and a serverless function has a wall-clock budget.
 * We always report how much we actually covered so the caller can label the
 * result as partial rather than quietly presenting a sample as the whole.
 */
export async function paginate(method, params, { key, maxPages = 25, onPage } = {}) {
  const items = [];
  let marker;
  // Count completed fetches directly. Deriving the count from the loop index
  // afterwards is off by one whenever the loop ends on the ceiling rather than
  // on a break, which reports more coverage than we actually have — the one
  // direction this number must never be wrong in.
  let fetches = 0;
  while (fetches < maxPages) {
    const r = await rpc(method, marker ? { ...params, marker } : params);
    fetches++;
    items.push(...(r?.[key] || []));
    onPage?.(fetches, items.length);
    marker = r?.marker;
    if (!marker) break;
  }
  return { items, pages: fetches, complete: !marker, truncated: Boolean(marker) };
}

/** Bounded-concurrency map that preserves order and never rejects. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        try { out[i] = await fn(items[i], i); }
        catch (e) { out[i] = { error: e.message }; }
      }
    })
  );
  return out;
}

/**
 * XRPL currency codes are either 3 ASCII characters or 40-char hex for longer
 * names. RLUSD is hex; USD is not. Getting this wrong renders "RLUSD" as an
 * unreadable hex blob on the dashboard.
 */
export function decodeCurrency(code) {
  if (!code) return code;
  if (code.length <= 3) return code;
  try {
    const decoded = Buffer.from(code, 'hex').toString('utf8').replace(/\0+$/, '');
    return decoded || code;
  } catch { return code; }
}

export function encodeCurrency(symbol) {
  if (!symbol) return symbol;
  if (symbol.length <= 3) return symbol;
  return Buffer.from(symbol, 'utf8').toString('hex').toUpperCase().padEnd(40, '0');
}

/** Ripple epoch is 2000-01-01, not 1970. A 30-year offset is not a rounding error. */
export const RIPPLE_EPOCH = 946684800;
export const rippleTimeToIso = t =>
  Number.isFinite(t) ? new Date((t + RIPPLE_EPOCH) * 1000).toISOString() : null;

/** Account root flags we care about for compliance posture. */
export const ACCOUNT_FLAGS = {
  lsfRequireDestTag:  0x00020000,
  lsfRequireAuth:     0x00040000,
  lsfDisallowXRP:     0x00080000,
  lsfDisableMaster:   0x00100000,
  lsfNoFreeze:        0x00200000,
  lsfGlobalFreeze:    0x00400000,
  lsfDefaultRipple:   0x00800000,
  lsfDepositAuth:     0x01000000,
  lsfAllowTrustLineClawback: 0x80000000,
};

export function decodeAccountFlags(flags) {
  const n = Number(flags) || 0;
  const set = {};
  for (const [name, bit] of Object.entries(ACCOUNT_FLAGS)) {
    // >>> 0 keeps the 0x80000000 clawback bit from going negative in JS.
    set[name] = ((n & bit) >>> 0) !== 0;
  }
  return set;
}
