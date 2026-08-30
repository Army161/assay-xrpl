# Assay

**Tokenized asset intelligence for the XRP Ledger.** Who holds a token, how concentrated that holding is, and what the issuer can actually do about it — read from mainnet at the moment you ask.

```bash
curl 'https://<your-deployment>/api/assay?asset=rlusd'
```

---

## What it answers

| Question | Where it comes from |
|---|---|
| How much of this token exists? | Issuer `gateway_balances` obligations — authoritative |
| Who holds it, and how concentrated is that? | Paginated trustlines, divided by **issued supply** |
| Can the issuer freeze a holder? Claw back? Gate who holds it? | Decoded account-root flags, per-check evidence |
| Is the issuer linked to a real entity? | `Domain` field on the issuing account |
| Which institutional ledger features are live? | `feature` — read from the network, never hardcoded |

Ask it in English via `POST /api/agent`, which answers only from live tool calls.

---

## The bug this codebase is built around

A large issuer has more trustlines than one request can page through. The obvious implementation sums the balances it fetched and divides each holder by that sum.

On live RLUSD data that produced **“top holder = 70.96% of supply.”**

The true figure was **4.90%**. The sample covered 72M of 1,041M issued, so the denominator was 14× too small. As a headline on a risk dashboard, that is a solvency alarm invented out of a pagination limit.

So, throughout:

- Concentration divides by **authoritative issued supply**, never by the observed sum.
- Partial coverage is stated on every response, with the size of the unseen remainder.
- Every concentration figure under partial coverage is labelled a **lower bound**.

`test/scoring.test.mjs` pins this with the real numbers. If someone refactors the denominator, the suite fails.

---

## What it does *not* do

Stated plainly because the gap matters more than the feature list:

- **It cannot see reserves.** Issued supply is what the ledger says was issued. Whether it is backed is an off-chain fact. No on-chain tool can verify it, and this one does not pretend to.
- **Posture measures capability, not compliance.** That an issuer *can* freeze says nothing about whether it is licensed, solvent, or following its own policy. Not legal advice, not a certification.
- **It is not an audit.** It is a fast, evidence-linked first pass that tells a diligence team where to point their questions.

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/assay?asset=<id\|r-address>` | Full report for one asset |
| `GET /api/portfolio` | Every registry asset, ranked weakest-posture-first |
| `GET /api/amendments` | Which institutional amendments are live on mainnet |
| `POST /api/agent` | Natural-language analyst over live ledger state |
| `GET /api/health` | Liveness, tiers, caveats |

`asset` accepts a registry id (`rlusd`, `bitstamp`, `gatehub`) or any XRPL `r`-address.

Tiers gate **depth** — how many holder pages get fetched — not methodology. Every tier gets the same score and the same caveats; paid tiers page deeper and therefore tighten the bounds.

---

## Local

```bash
npm install
npm test          # 18 offline tests, no network
npm run dev       # http://localhost:3000
```

Only `/api/agent` needs a key (`ANTHROPIC_API_KEY`). Every measurement endpoint works without one.

---

## Configuration

| Variable | Needed for |
|---|---|
| `ANTHROPIC_API_KEY` | The AI analyst |
| `STRIPE_SECRET_KEY` | Billing |
| `STRIPE_PRICE_DESK` / `_FIRM` / `_ENTERPRISE` | Subscription tiers |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `PUBLIC_ORIGIN` | Checkout redirect URLs |
| `ASSAY_KEYS` | Static `key:tier` pairs for partners |

Everything degrades cleanly. No Stripe → free tier only, buttons disabled. No Anthropic key → analyst returns 503, all measurement still works.

---

## Design notes

**No database.** API keys live in Stripe subscription metadata; tiers resolve against Stripe live. Stripe already knows who is paying — duplicating that into a database creates a second thing to get wrong, and a cancelled subscription stops working immediately with no revocation job to forget.

**One runtime dependency.** `@anthropic-ai/sdk`, used only by the analyst. The measurement core is Node built-ins.

**Status is never colour alone.** Red/green sit at ΔE 4.1 under deuteranopia — indistinguishable for ~8% of men. Every pass/fail carries a glyph *and* a text label.

---

## Licence

MIT
