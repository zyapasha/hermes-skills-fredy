# Hunt-loop competition signals

When a mint API returns multiple "not-yours" states for hunt-style requests
(`/find-mint-code` etc.), they carry distinct competition signals. Don't lump
them all into "miss" in your logs.

## Response taxonomy (CPUNKS-style, generalizable)

| Server response                   | Meaning                                                     | Signal             |
|-----------------------------------|-------------------------------------------------------------|--------------------|
| `invalid_timestamp`               | This second isn't a winner. You guessed wrong.              | unlucky            |
| `timestamp_already_used` (`claimed`) | Winner timestamp, but on-chain mint already happened.    | competitor minted  |
| `timestamp_already_issued` (`issued`) | Winner timestamp, mintCode already issued (to another wallet) but not yet minted on-chain | **lost a millisecond race** |
| `rate_limit` / `rate_limit_wallet` | Server cooldown active. Backoff and retry.                  | API floor hit      |
| HTTP 429                          | IP-level burst limit. Stop concurrency.                     | bypass attempt failed |
| `ok: true`                        | HIT — mintCode bound to your wallet, sign+broadcast NOW.    | win                |

## Why `issued` matters

`issued` means another wallet hit the **same** winning timestamp microseconds
before you. The contract's mintCode is now allocated to them. They will
broadcast within a few seconds and your `find-mint-code` for that ts will flip
to `claimed`. You did not miss the timestamp — you lost a sub-second race.

Two issued + two claimed in 71 attempts (CPUNKS batch 7, 2026-05-15) means:
- We were genuinely competing against ≥1 other automated bot
- Their fire-T+0 timing is within ~50ms of ours
- Improving our local stack further (TLS keepalive, faster RPC) won't move the needle without multi-IP or different timestamp ordering

## Quick analytics one-liner

After a run, classify hunter log:

```bash
echo "Total attempts: $(grep -c '^\[' /tmp/mint.log)"
grep -oE "(miss|claimed|issued|HIT|net err|parse_error)" /tmp/mint.log | sort | uniq -c | sort -rn
```

Interpretation:
- `claimed + issued ≥ 5%` of attempts → **bot competition real**, optimize timing/IP
- `claimed + issued = 0` → either no competition or you're not hitting winners → check ts shuffle / range correctness
- `net err > 30%` → API or network unstable, swap RPC or check rate-limit handling
- `parse_error > 5%` → server returning HTML/empty bodies, likely transient overload

## Empirical variance across consecutive batches

Same wallet, same atomic script, T+0 fire on each batch boundary
(CPUNKS 2026-05-15, wallet 0xcD23...5881):

| Batch | Attempts | HIT | Notes                                                |
|-------|----------|-----|------------------------------------------------------|
| 5     | 41       | 1   | First-mover advantage; competitors not warm yet      |
| 6     | 97       | 0   | Heavy bot activity, ratio drops < 1% mid-batch       |
| 7     | 71       | 0   | 2 issued + 2 claimed = real ms-level race losses     |

Implication: **expect P(0 hits in a batch) > 30% even with optimal setup**.
Do not promise the user "we'll definitely get one this batch". Treat each
batch as an independent Bernoulli draw with outcome dominated by external
competition, not local optimization.
