---
name: evm-mint-preflight
description: Pre-flight checks before broadcasting a paid EVM NFT mint tx. Catches the most common silent-revert causes — EIP-7702 delegated wallets that can't receive _safeMint, wrong msg.value vs MINT_PRICE, mintCode already used, signature single-use API quirks, gas underestimate. Use this whenever you're about to call a payable mint(...) on an ERC721/ERC1155 contract with money on the line. Bundled scripts include revoke7702.js to revoke 7702 delegation and atomic-hunt-mint.js for atomic hunt-sign-broadcast against single-use sign endpoints.
---

## When to use

Before broadcasting any paid mint tx (especially from `wallet-burn` / fresh wallets / smart accounts). Run these checks in order. The 7702 check is the silent killer — wallets that look like EOAs but have delegate code revert `_safeMint` with `ERC721InvalidReceiver`.

## Pre-flight checklist

### 0. PK availability + wallet metadata — DO THIS FIRST

Before any contract analysis, Sourcify pull, ABI grep, or `eth_call` storm: **verify you can actually sign a tx for the wallet the user wants to use**. The most expensive failure mode in this skill isn't a revert — it's spending 10 minutes characterizing the contract and then discovering the PK was shredded last session, leaving the user to mint manually because you wasted their window.

Empirical (2026-05-16 Syntax mint, mainnet, free): user said "wallet burn bro, lu eksekusi langsung." I ran full preflight (chain, contract, mintPrice, MAX_SUPPLY, seedFinalized, paused, hasMintedPublic, EOA check, gas estimate, balance) before checking `/tmp/syntax.pk` or `/tmp/cpunks.pk` — both shredded per prior session's post-campaign cleanup. Asked user to decrypt. User: "Udah gua mint sendiri. Kelamaan lu." Lost the run because PK availability was checked LAST instead of FIRST.

**Step 0 sequence** (do these in parallel via one terminal call, not serially):

```bash
# 1. Find wallet metadata file matching the user's reference label
ls -la ~/.hermes/wallets/owner/  ~/.hermes/wallets/agent/  ~/.hermes/wallets/evm/ 2>/dev/null

# 2. Inspect metadata (no plaintext PK leak — only label, group, address, encrypted_file path)
python3 -c "
import json,sys
d=json.load(open('$HOME/.hermes/wallets/owner/wallet-burn.json'))
for k,v in d.items():
    if any(x in k.lower() for x in ['private','seed','mnemonic']): print(f'{k}: <REDACTED>')
    else: print(f'{k}: {v}')
"

# 3. Check if PK is decryptable / available
ls -la /tmp/<wallet>.pk 2>/dev/null   # ephemeral, may have been shredded
ls -la ~/.hermes/wallets/private/wallet-owner-evm-private-keys.txt.enc 2>/dev/null   # encrypted, needs user passphrase
```

**Decision tree at step 0:**
- PK at `/tmp/<wallet>.pk` and readable → proceed to step 1 of preflight
- Encrypted file exists, no plaintext → STOP preflight here. Tell user "decrypt + paste to /tmp/<wallet>.pk via terminal, bilang go". Decrypt is a manual user action gated on the user's passphrase; don't waste a 5-minute preflight before discovering the gate is closed
- No metadata + no encrypted file → ask user which wallet to use, get address + PK source path. Do not proceed until both are answered

The user's setup keeps secrets encrypted at rest with passphrase known only to the user (FREDY_OPS rule). After post-campaign cleanup (`shred /tmp/<wallet>.pk`), the next session starts from encrypted-only state. Treat plaintext PK as expected-absent until proven present.

**Anti-pattern**: the readiness check at step 0 should NOT decrypt the PK or echo any portion of it. Just verify (a) the encrypted file exists, (b) the metadata file matches the address the user named, (c) `/tmp/<wallet>.pk` is either present-and-readable or absent-and-needs-restore. Decryption is the user's call after you've confirmed all the OTHER preflight steps will succeed once the PK lands.

### 0b. Contract discovery via OpenSea API when frontend is opaque

If the user gave you a mint URL but no contract address (common for Next.js / IPFS-hosted dapps that obfuscate contract refs across multiple webpack chunks), don't grep 12 minified JS bundles for the contract address. Use the OpenSea collection API — no key required:

```bash
SLUG=syntaxcoder   # the collection slug from opensea.io/collection/<slug>
curl -s "https://api.opensea.io/api/v2/collections/$SLUG" -H "accept: application/json" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f\"name: {d.get('name')}\")
print(f\"total_supply: {d.get('total_supply')}\")
for c in d.get('contracts',[]):
    print(f\"contract: {c.get('address')}  chain: {c.get('chain')}\")
for e in d.get('editors',[]):
    print(f\"editor: {e}\")
"
```

Empirical (2026-05-16 Syntax mint): the dapp's bundles only exposed `0x8a8a72576a557ad330de048641e8bf905f064eb4` (the editor wallet, not the contract). On-chain `eth_getCode` against it returned `0x` on Base/Arbitrum/Optimism/Zora/Blast/Linea/Scroll/Mode/Mantle/zkSync/Taiko/Abstract/Bera/Ink/Worldchain/Soneium/Unichain/mainnet — all empty. OpenSea API immediately returned the actual contract `0xc057170b4b46563df0970a823f4d94186b741858` on `ethereum` mainnet, plus the `editors` array clarified what the address from the bundle actually was. Total time: one curl, no JS bundle parsing.

`contracts` is an array — multi-chain collections list each chain. `chain` strings: `ethereum`, `base`, `arbitrum`, `optimism`, `zora`, `polygon`, `avalanche`, `klaytn`, etc. (OpenSea's chain slugs, not chainIds — map them yourself if you need numeric).

When OpenSea returns 404 or empty `contracts`, fall back to bundle grep. But default to API first; it's faster and definitive.

### 1. `eth_getCode(wallet, "latest")` — detect 7702 / smart account

Before broadcasting any paid mint tx (especially from `wallet-burn` / fresh wallets / smart accounts). Run these checks in order. The 7702 check is the silent killer — wallets that look like EOAs but have delegate code revert `_safeMint` with `ERC721InvalidReceiver`.

## Pre-flight checklist

### 0. Identify the contract address and chain (when user shares only a collection / mint URL)

Users typically share an OpenSea collection link or a mint site URL — not the actual mint contract. Recover both before any on-chain check.

**OpenSea API (no key needed, fastest path):**
```bash
curl -s "https://api.opensea.io/api/v2/collections/<slug>" -H "accept: application/json"
```
Returns `contracts: [{address, chain}]`. Distinguish `editors` / `creator` (deployer wallet, often shares a prefix with the contract — easy to confuse) from `contracts` (the actual NFT contract you'll mint against). Empirical (2026-05-16 SYNTAX): user shared `opensea.io/collection/syntaxcoder` + a mint site whose HTML referenced `0x8a8a...4eb4`. That was the editor wallet, not the contract. The real contract `0xc057170b4b46563df0970a823f4d94186b741858` only appeared via the OpenSea API. **Don't trust the first 0x... you find in the page DOM.**

**Mint site bundle scrape (fallback when no OpenSea entry yet):**
1. `curl` all `_next/static/chunks/*.js` referenced by the page (Next.js sites are common for mint UIs).
2. `grep -ohE '0x[a-fA-F0-9]{40}' *.js | sort -u` — dedupe candidate addresses.
3. Cross-reference with the OpenSea editor/creator field to filter out wallet addresses.

**Chain identification when you have a contract but unknown chain:**
Hit `eth_getCode` across major chains in parallel; the contract is on whichever returns code length > 2 (`"0x"` is empty / 2 chars).
```bash
for label_rpc in \
  "ETH|https://ethereum-rpc.publicnode.com" \
  "BASE|https://mainnet.base.org" \
  "ARBITRUM|https://arb1.arbitrum.io/rpc" \
  "OPTIMISM|https://mainnet.optimism.io" \
  "ZORA|https://rpc.zora.energy" \
  "BLAST|https://rpc.blast.io" \
  "POLYGON|https://polygon-rpc.com" \
  "LINEA|https://rpc.linea.build" \
  "SCROLL|https://rpc.scroll.io" \
  "BERA|https://rpc.berachain.com" \
  "ABSTRACT|https://api.mainnet.abs.xyz" \
  "INK|https://rpc-gel.inkonchain.com" \
  "WORLDCHAIN|https://worldchain-mainnet.g.alchemy.com/public" \
  "SONEIUM|https://rpc.soneium.org" \
  "UNICHAIN|https://mainnet.unichain.org"; do
  label="${label_rpc%%|*}"; rpc="${label_rpc#*|}"
  code_len=$(curl -s --max-time 5 "$rpc" -X POST -H "content-type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$CONTRACT\",\"latest\"],\"id\":1}" \
    | python3 -c 'import sys,json; r=json.load(sys.stdin).get("result",""); print(len(r))' 2>/dev/null)
  echo "  $label: code_len=$code_len"
done
```

**Don't infer chain from low gas price.** A mint screenshot showing 0.2 gwei + $0.06 USD looks like an L2 reflex, but Ethereum mainnet itself routinely runs at 0.1-0.3 gwei base fee in the 2025-2026 deflationary regime. Verify chain via `eth_getCode > 0x` proof, never via gas heuristics. Empirical (2026-05-16 SYNTAX): swept 7 L2s + zora/blast/etc. on the assumption "0.24 gwei must be L2", all returned empty. Contract was on mainnet — gas was just genuinely low that day. Cost me a tool-call round.

Once you have `(CONTRACT, CHAIN_ID)`, proceed to step 1.

### 1. `eth_getCode(wallet, "latest")` — detect 7702 / smart account

```bash
curl -s $RPC -X POST -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$WALLET\",\"latest\"],\"id\":1}"
```

- `0x` → pure EOA, safe for `_safeMint` ✓
- `0xef0100...` → **EIP-7702 delegated**. Check if delegate implements `onERC721Received(address,address,uint256,bytes) returns (bytes4)`. If not, mint will revert with `ERC721InvalidReceiver(wallet)`.
- Other bytecode → contract address. Most NFTs revert into contracts unless the contract handles ERC721 receiver.

If 7702 and ga handle ERC721: revoke first (see `revoke-7702` step below) atau pake wallet EOA bersih lain.

### 2. Verify contract ABI + revert errors

Pull verified source from Sourcify (works without API key, redirects properly with `-L`):

```bash
curl -sL -o /tmp/meta.json \
  "https://repo.sourcify.dev/contracts/full_match/$CHAIN_ID/$CONTRACT/metadata.json"
```

List custom errors — these are the revert selectors you'll need to decode:

```python
import json
m = json.load(open('/tmp/meta.json'))
for item in m['output']['abi']:
    if item.get('type') == 'error':
        print(f"  {item['name']}({','.join(i['type'] for i in item.get('inputs',[]))})")
```

Source content is at `https://repo.sourcify.dev/contracts/full_match/$CHAIN/$ADDR/sources/<path>` — read the `mint()` function to confirm pricing logic, signer recovery, supply caps.

### 3. Match `msg.value` to actual price

- Static call `MINT_PRICE()` (selector `0xc002d23d`) or `mintPrice()` (`0x6817c76c`) or whatever the contract exposes.
- Many backends return `priceWei` from a sign endpoint — verify it matches the on-chain constant before trusting.

### 4. Sign endpoint single-use behavior

Some backends (CPUNKS confirmed) drop the mintCode after first `/sign` call. Pattern:
- DRY-RUN that calls sign API → captures signature in output
- Plan to BROADCAST that calls sign API again → fails with `mint_code_not_found`

**Fix (preferred)**: don't separate dry-run from broadcast — use one atomic process that hunts → calls /sign → broadcasts in the same script. See `scripts/atomic-hunt-mint.js` (Node, ethers v6) for a working template. It also includes a 7702 pre-flight check that aborts before wasting gas.

**Fallback (if you already separated and burned the /sign call)**: capture `signature` + `priceWei` from the first response into env vars and skip the API on broadcast. ECDSA signatures are stateless — the contract verifies via `ecrecover`, doesn't care about backend state. As long as the mintCode hasn't been used on-chain, the cached signature still works.

**Critical corollary — leftover mintCodes from PRIOR batches are unmintable.** If you find an old `cpunks_hit_bN.json` (or any persisted hit) from a batch that has since closed, do NOT try to revive it. Even when on-chain `usedMintCodeHash(hash) = 0` (proving the code was never minted) and `signer()` is unchanged, the `/sign-mint-code` backend purges expired mintCodes from its sign cache after the batch boundary and returns `HTTP 404 {"ok":false,"error":"mint_code_not_found"}`. Without a fresh server signature you cannot synthesize a valid `ecrecover` proof — the signer's private key is operator-held. Empirical (CPUNKS 2026-05-15): mintCode `0xc4c4...6ca2` from batch 3, on-chain checks all green (usedMintCodeHash=0, signer match, mintedByWallet=1<10), sign endpoint returned 404 ~4 hours after batch 3 closed. Zero gas burned (sign failed before broadcast), but zero recovery either. Signal to the user honestly: "old mintCode is dead, on-chain validity ≠ server validity."

### 5. Decode revert with `debug_traceTransaction` / `debug_traceCall`

If a tx still reverts:

```bash
curl -s $RPC -X POST -d '{"jsonrpc":"2.0","method":"debug_traceTransaction","params":["'$TX'",{"tracer":"callTracer"}],"id":1}'
```

- `output` field = ABI-encoded revert reason. First 4 bytes = error selector.
- Match selector against errors in step 2:

```python
from eth_utils import keccak
errors = ['WrongPrice()', 'MintCodeAlreadyUsed()', 'InvalidSignature()',
         'MaxPerWalletReached()', 'SoldOut()', 'ZeroAddress()',
         'ERC721InvalidReceiver(address)']  # add per-contract
for e in errors:
    print(f"0x{keccak(text=e)[:4].hex()}  {e}")
```

**`debug_traceCall` requires 3 params** (block + config object), not 2. Common gotcha:
```bash
# WRONG: ...,"params":[{tx},"latest"]
# RIGHT: ...,"params":[{tx},"latest",{"tracer":"callTracer"}]
```

Also: when reproducing a reverted tx via `debug_traceCall`, copy the **exact** `value` from the original tx (`eth_getTransactionByHash`), not from your script env. Mismatched value yields wrong revert selector and sends you down the wrong rabbit hole.

### 6. Revoke EIP-7702 delegation (if needed)

Use the bundled paste-ready script: `scripts/revoke7702.js` (under this skill).

```bash
cd /tmp && mkdir -p revoke && cd revoke
npm init -y >/dev/null && npm install ethers@6 >/dev/null
cp ~/.hermes/skills/blockchain/evm-mint-preflight/scripts/revoke7702.js .
RPC_URL=https://ethereum-rpc.publicnode.com \
PRIVATE_KEY="$(cat /tmp/wallet.pk)" \
BROADCAST=1 \
node revoke7702.js
```

Self-tx type-4 with delegate = `0x0`, ethers v6.16+. Cost ~37k gas (≈0.000005 ETH at 0.13 gwei). After mining, `eth_getCode` → `0x`, wallet pure EOA again.

**BigInt JSON pitfall**: ethers v6 `wallet.authorize()` returns `auth.nonce` and `auth.chainId` as `BigInt`. `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on these. Always guard:
```js
nonce: typeof auth.nonce === "bigint" ? auth.nonce.toString() : auth.nonce,
```
The bundled script handles this.

**Auth nonce rule**: when `sender == authorizer` (self-revocation, common case), `auth.nonce` MUST equal `tx.nonce + 1`, because the tx itself bumps the nonce before the authorizationList is processed. Other cases use the authorizer's actual current nonce.

eth_account 0.13+ also supports `Account.sign_authorization(...)` for Python builders.

## Pitfalls

- **Don't trust dry-run cost as final**. EIP-1559 gas can spike between dry-run and broadcast. Cek lagi `eth_gasPrice` sebelum sign final tx.
- **`estimateGas` failure ≠ tx will fail**. Some RPCs (Ankr free tier) require API key; failure is RPC-level, not contract-level. Fallback to a generous gasLimit (180k for ERC721 mint+sigverify is plenty).
- **Don't quote API selectors from memory.** Always recompute `keccak(text="...")[:4]` — typos in error names give wrong matches. **System python rarely has `eth_utils` or `pycryptodome`.** If `from eth_utils import keccak` fails, fall back in this order:
  1. **Project venv that already has it** — Hermes ships with telegram-monitor and hermes-agent venvs. Check both:
     ```python
     import sys
     for p in [
         '/home/ubuntu/.hermes/telegram-monitor/venv/lib/python3.12/site-packages',
         '/home/ubuntu/.hermes/hermes-agent/venv/lib/python3.12/site-packages',
     ]: sys.path.insert(0, p)
     from Crypto.Hash import keccak  # pycryptodome ships with hermes-agent venv
     def kec(s):
         k = keccak.new(digest_bits=256); k.update(s.encode()); return k.digest()
     # selector = '0x' + kec("hasMintedPublic(address)")[:4].hex()
     ```
  2. **Node + ethers** if you have a node project lying around (e.g. `/tmp/<project>_node`):
     ```bash
     node -e 'const {keccak256, toUtf8Bytes} = require("ethers"); console.log(keccak256(toUtf8Bytes("mint(uint256)")).slice(0,10))'
     ```
  3. **NIST `hashlib.sha3_256` is NOT keccak-256.** They differ in padding. Don't use stdlib `hashlib.sha3_*` for Ethereum selectors — you'll get wrong values that compile fine and silently mismatch.
- **"Wallet" param in some sign endpoints is required** — even if mintCode is already bound onchain, the sign endpoint may need wallet to scope the signature.
- **Hunt response often omits the wallet field**. The `find-mint-code` HIT JSON might only return `{ok, mintCode, activeBatch}` — no wallet. If you persist the hit to a file for downstream tools, add the wallet yourself; many executor scripts assume `hit.wallet` exists.
- **Carriage-return logging never flushes under Hermes background runs.** `process.stdout.write("...\r")` will appear empty when polled via `process(action='log')`. Use `console.log` (newline-terminated) or redirect to a real file (`> /tmp/hunt.log 2>&1`) and tail it. The bundled `atomic-hunt-mint.js` already uses `console.log`.
- **API rate-limit floor is the real bottleneck.** When the backend enforces a 10s cooldown, no client (Node, Python, curl) can go faster. Don't try to optimize that with concurrency or different RPCs — it's per-IP per-wallet. Plan for ~6 attempts/min and use the hit-rate threshold (next pitfall) to decide whether to keep hunting or bail to next batch. **Empirical proof (CPUNKS 2026-05-15)**: a same-IP burst of 5 parallel `/find-mint-code` requests returned `HTTP 429 Too Many Requests` on 4 of 5; only one slipped through. Concurrency on a single IP is wasted effort — the floor is enforced at the IP layer before per-wallet limits.
- **Competitor analytics — read your hunt log.** Distinguish `miss` (you guessed wrong) from `claimed` (winner already minted on-chain) from `issued` (winner mintCode just got bound to another wallet seconds ago, you LOST a millisecond race). When `claimed + issued ≥ 5% of attempts`, you're actively losing to bots, not just unlucky. See `references/competition-signals.md` for the full taxonomy and a one-liner to classify your log.
- **Don't promise hits.** P(0 hits per batch) is empirically >30% even with T+0 fire and optimal local stack. Each batch is an independent Bernoulli draw dominated by external competition. Tell the user this BEFORE the run; don't oversell. See `references/competition-signals.md` for the variance table.
- **Hit-rate decision rule for batched mints.** If `winners_left / range_size < 1%`, the batch is effectively dead — kill the hunter and wait for the next batch. The atomic-hunt-mint script auto-bails when this fires.
- **`pgrep -f "node mint.js"` matches the bash launcher, not just node.** When you spawn the hunter via a bash wrapper (`bash -c '... node mint.js ...'`), `pgrep -f` matches BOTH the bash command-line AND the real node process — and a watcher that grabs the first match will sit on the bash PID and miss the real worker. Filter to actual node processes:
  ```python
  out = subprocess.check_output(["pgrep", "-x", "node"], text=True).strip()
  for pid in out.splitlines():
      cmd = open(f"/proc/{pid}/cmdline","rb").read().replace(b"\x00",b" ").decode()
      if "mint.js" in cmd: return int(pid)
  ```
  Same applies to any Python/Ruby/Java worker launched through a wrapper — match the executable, then cross-check `/proc/$pid/cmdline`.
- **`parse_error` must retry, not break.** When the API returns non-JSON (HTML error page, 502 Bad Gateway, partial body), the hunter's `apiPost` resolves with `{ok:false, error:"parse_error", raw:"..."}`. In `mint_v2.js` (CPUNKS 2026-05-15) this fell into the catch-all `else` branch and broke out of the inner loop, **advancing to the next timestamp without ever getting a real verdict on the current one**. Empirically saw 4× parse_error on b9 in 111 attempts (~3.6%) — that's 4 timestamps we burned for nothing. Fix: treat `parse_error` like `network_error` (retry the same timestamp 1-2s later):
  ```js
  if (result.error === "network_error" || result.error === "timeout" || result.error === "parse_error") {
    console.log(`  ${result.error}, retry 2s`);
    await sleep(2000);
    continue;
  }
  ```
  Cap retries (e.g. 3 attempts per ts) to avoid infinite loop on a permanently-broken endpoint.
- **Final batch competition intuition is BACKWARDS.** Common assumption: "last batch = least competition because most bots already minted." Reality (CPUNKS 2026-05-15): b9 was capped at **711/1111** (partial cap, see "Partial-cap final batches" above) and consumed in ~9 minutes (≈79 mints/min average) — FASTER than mid-event batches that took 20-30 min for the full 1111. Why: (1) bots that haven't hit yet are MORE desperate and fire more aggressively, (2) max-per-wallet=10 means even bots with prior wins can keep hunting, (3) collectors who held off treating b1-b8 as "warm-up" pile in for the finale, (4) partial cap shrinks the supply pool so race intensity per remaining slot is higher. Don't tell the user "this is the last batch so least competition" — it's often the opposite. Read `timestampsCount` from schedule before any expected-hit math, and assume final-batch consumption rate is 1.5-2× mid-event rate.
- **mintCode server-cache TTL ≤ batch_duration.** Empirical (CPUNKS 2026-05-15): batch 3 mintCode `0xc4c4...6ca2` was alive at hit time (07:33:18 UTC), still alive at first sign attempt during batch 3 window. By 11:17 UTC (~3h44m after b3 closed at 08:03:15Z), `/sign-mint-code` returned `HTTP 404 mint_code_not_found` despite on-chain `usedMintCodeHash=0`. Working assumption: server purges mintCode from sign cache at-or-shortly-after the batch's `endIso` boundary. Implication: **never plan a "sign later" workflow for time-windowed drops** — the sign endpoint is single-use AND the cache evicts quickly. If you have a hit, sign+mint atomically in the same script run, period. The only exception is if you can prove the backend persists mintCodes (e.g. by retrying minutes later in the same window and getting a fresh signature) — for CPUNKS we proved the opposite.
- **Watcher-vs-hunter PID detection breaks when batches overlap.** Even with the "match `node` + check cmdline" filter above, `pgrep` returns whichever hunter spawned first — which is wrong if a previous-batch hunter is still alive in "free run" mode while you arm the next batch. Empirical (CPUNKS 2026-05-15): user said "let b8 hunter free-run until natural exit", I armed b9 launcher + watcher in parallel. Watcher b9 spawned, called `find_hunter_pid()`, got b8's PID (still running), and faithfully monitored b8's batch counter against b9's "remaining ≤ 5" threshold. When b9 sold out, watcher SIGKILL'd b8's PID — meanwhile real b9 hunter was running on a different PID, untouched, and naturally exited later when b9 closed. No actual harm (b8 was about to die anyway), but the watcher logged a misleading "TRIGGER killing PID X" notification.
  **Fix**: have the launcher write its spawned hunter PID to a per-batch file, watcher reads from that file instead of pgrep:
  ```bash
  # launcher (after exec replaces it):
  exec node mint.js > /tmp/mint_b9.log 2>&1 &
  echo $! > /tmp/mint_b9.pid
  wait
  ```
  ```python
  # watcher:
  with open(f"/tmp/mint_b{TARGET_BATCH}.pid") as f:
      pid = int(f.read().strip())
  ```
  Or pass PID via env var when launching the watcher. Either way, eliminate the pgrep race entirely.

## Scheduling pattern for time-windowed batched mints

For drops that release fixed batches at known timestamps (CPUNKS-style — 9 batches × 30 min × 1111 winners), set up TWO background processes:

1. **Launcher** — bash wrapper that sleeps until the batch start time, then `exec node atomic-hunt-mint.js > /tmp/mint.log 2>&1`. **Use nanosecond-precision sleep so you fire at T+0s (not T+3s buffer)**:
   ```bash
   SLEEP_UNTIL_NS=$(date -u -d '2026-05-15T10:53:15.580Z' +%s%N)
   NOW_NS=$(date +%s%N)
   DELAY_S=$(awk "BEGIN { printf \"%.3f\", ($SLEEP_UNTIL_NS - $NOW_NS) / 1000000000 }")
   sleep $DELAY_S
   ```
   Empirical (CPUNKS 2026-05-15, 4 batches): the backend flips `activeBatch` exactly at the boundary timestamp; hunter spawned at T+1.0s consistently grabs `claimed=0` window. The script's own retry loop (`while not activeBatch: sleep 3s`) handles the rare case where the API hasn't flipped yet — DON'T add a static 3s wall-clock buffer in the launcher, it just hands competitors a free 3s headstart. **Earlier guidance in this skill said 3s buffer; that was over-cautious. T+0 wins.**
2. **Watcher** — Python script polling `/api/schedule` every 10s. Kills the hunter when `remaining ≤ 5` so the wallet doesn't spend 30 min hammering a sold-out batch with `timestamp_already_used` responses. Threshold of 5 leaves room for last-second hits without lingering.

### Free-run mode: when to disable the watcher

The watcher exists to stop the hunter wasting API budget on sold-out batches. But the user can override: "let it run until natural close" / "gas aja sampai habis" means the hunter should hunt the full batch window and exit only on (a) HIT+mint, (b) batch closed natural-end, or (c) `no_active_batch` from the API.

**To enable free-run**: kill ONLY the watcher (`kill $WATCHER_PID`), leave the hunter alone. The hunter naturally exits via `if (result.error === "no_active_batch") return;` once the batch closes server-side. Empirical (CPUNKS 2026-05-15 b8): user said "natural exit aja" mid-batch when sisa was ~36; killed watcher, hunter ran another ~80 attempts, exited cleanly when batch boundary tipped.

**Don't kill the hunter when entering free-run mode** — that's the opposite of what the user asked for.

**Don't forget to disable the watcher's auto-kill before arming the NEXT batch's pipeline** — see the "Watcher-vs-hunter PID detection breaks when batches overlap" pitfall above for what goes wrong otherwise.

### Partial-cap final batches

Some drops cap their final batch lower than the standard winner count. Empirical (CPUNKS 2026-05-15): batches 1-8 were each 1111/10000 winners; batch 9 was capped at **711/1111** (~64% supply) likely to ensure the collection sells out cleanly. Implication: the very last batch has a smaller hit-rate denominator and sells faster than mid-event batches.

Don't promise the user "this is the last batch so least competition" — partial caps mean the opposite is often true. Read the schedule's `timestampsCount` for the target batch BEFORE giving any expected-hit math.

Both run via `terminal(background=true)` with `watch_patterns=["HIT","MINT SUCCESSFUL","Token ID","Mint failed","Fatal","TRIGGER"]`. The agent gets notified on any meaningful state change without polling.

Avoid the temptation to merge launcher + watcher into one supervisor: separate processes mean a bug in one (e.g. the `pgrep` gotcha above) doesn't compromise the actual mint window.

### Kill stale hunters from prior batches BEFORE the next launcher fires

Per-IP rate-limit budget is shared across all hunter processes on the same machine. A previous-batch hunter that's still spinning `/find-mint-code` against a sold-out batch keeps the 10s cooldown clock active for your IP — which means the next-batch hunter's FIRST attempt (the most valuable one) starts already inside a rate-limit window and burns its first 10s waiting.

The launcher's bundled "kill stale hunters at T-1s" cleanup is too late: by then the cooldown timer has already started ticking from the stale hunter's last request, and the new hunter inherits ~0-9s of leftover wait.

**Rule**: kill stale hunters as soon as their target batch shows `consumedCount == timestampsCount` AND `soldOut == true`. Don't wait for the next launcher to clean up. A simple manual `kill -9 $(pgrep -f "node mint")` between batches is fine — the watcher already handles auto-kill at `remaining ≤ 5`, but if the user re-armed for a later batch and forgot to clean up, the prior hunter survives in zombie-like state burning API budget.

Empirical (CPUNKS 2026-05-15): b8 hunter still running 30+ min after b8 sold out, hammering `/find-mint-code` every 10s with `claimed`/`miss` responses. T-2min before b9 fire, killing it manually freed the rate-limit window so b9's first attempt fired clean at T+1s instead of T+8s.

## Hunter inner-loop latency optimizations

Once the launcher fires at T+0 and the hunter is the only thing standing between you and the mint, these micro-optimizations are what actually move the needle. Empirical CPUNKS 2026-05-15 baseline (`mint.js`) → optimized (`mint_v2.js`):

1. **HTTP keep-alive agent** — reuse the TLS connection across `/find-mint-code`, `/sign-mint-code`, `/schedule`. Saves ~150ms per request (TLS handshake). Over 100 attempts that's 15s of pure latency removed.
   ```js
   const https = require("https");
   const keepAliveAgent = new https.Agent({
     keepAlive: true, keepAliveMsecs: 30000,
     maxSockets: 10, maxFreeSockets: 5,
   });
   // pass {agent: keepAliveAgent} on every https.request()
   ```
2. **Parallel pre-warm before fire** — when the hunter starts, kick off `getBalance + getNetwork + apiGet("schedule")` in a single `Promise.all`. The schedule call also warms the TLS socket to the API host so the first `/find-mint-code` doesn't pay the handshake cost.
3. **Schedule polling 500ms (not 3000ms)** — the launcher sleeps until T+0 then the hunter waits on `activeBatch` to flip. At 3s polling you can lose up to 3s. At 500ms you lose ≤0.5s. With per-IP rate limit at 10s, this only matters once (the very first attempt), but that one attempt is the most valuable one in the entire run.
4. **Drop inter-attempt soft pacing** — code like `await sleep(150)` between attempts is dead weight; the API's own `rate_limit` response already paces you to 10s. Remove it.
5. **Respect `retryInMs` exactly, no padding** — when the API returns `{retryInMs: 10000}`, sleep exactly 10000ms (not 10500). Padding is wasted budget. Sign endpoint may need +500ms because its window is shorter and tighter; verify per-endpoint.

What does NOT meaningfully help:
- Spawning multiple Node workers on the same IP — IP-level rate limit caps you (see "Multi-wallet parallelization economics" above; `HTTP 429` on 4/5 parallel was the empirical proof).
- Pre-fetching fee data — ethers v6 does this internally, and on a single mint tx the savings are sub-100ms versus the seconds you spend waiting for `/sign`.

Reference implementation: `scripts/atomic-hunt-mint.js` includes all five real optimizations.

### Verify code changed, not just comments

When iterating on a hunter and labeling improvements (`// IMPROVEMENT #N: ...`), audit each commented improvement against actual code-vs-prior-version diff. Comments are cheap to add; real changes have to show up in the AST. Empirical example (mint.js → mint_v2.js):
- `// IMPROVEMENT #2: pre-fetch fee data to skip eth_feeHistory` — comment added, but `sendMintTx` was byte-identical. Zero perf change.
- `// IMPROVEMENT #5: respect retryInMs precisely (was +500ms padding)` — the v1 code already had no padding on `find-mint-code`. The change was real only for `/sign`, but the comment was on the wrong endpoint.

If you can't show the diff that delivers the claimed speedup, the comment is decoration. Don't trust your own labels — diff before claiming.

### Strategic ceiling: when local optimizations stop mattering

If you fire T+0 with all five optimizations above and get **zero hits across ≥3 consecutive batches** despite normal hit-rate-per-attempt math (e.g. 1111 winners in 10000-ts range = ~11% per attempt, 130 attempts → expected ~14 hits), the bottleneck has moved off your machine:

- Competitors are firing **before** T+0 (server clock skew, T-Nms scheduler, or the API leaks `activeBatch` status before the boundary timestamp). At that point, every winner code is consumed within milliseconds and your T+0 hunter sees only `claimed` / `issued` errors, never `ok: true`.
- More local optimization buys you nothing. The fix is either (a) figure out the pre-fire signal competitors use, (b) bring more wallets across separate IPs (proxies, but see economics section), or (c) accept the variance and treat each batch as a low-EV lottery ticket.

Tell the user honestly when you've hit this ceiling. Don't keep optimizing local code claiming "next batch will be different" — the variance distribution doesn't change just because your code did.

### Pre-launch announcement watcher (poll Twitter + site, alert on launch keyword)

Different from the time-windowed launcher above: this is for mints where the contract / mint button / "live now" tweet hasn't dropped yet, and you only know "minting may 15" or "launching soon". The pattern is a polling cron that hashes the source pages, alerts on keyword match, stays silent otherwise. Empirical (2026-05-15): set up for `@abnormalmfers` (15min → 10min interval) and originally for `@zecscriptions` (30min) before user dropped the second project.

**Cron shape** (use `cronjob(action='create')`):

```python
cronjob(action='create',
        name='<project>-launch-watcher',
        schedule='*/10 * * * *',                    # 10-15min for imminent, 30min+ for vague
        deliver='origin',                            # CRITICAL — chat-bound alerts
        enabled_toolsets=['terminal', 'file'],       # lean — no LLM tools needed for fetch+hash
        prompt='''Monitor @<handle> Twitter + <site> buat mint launch detection.

Steps:
1. Fetch tweets: curl -sL "https://r.jina.ai/https://x.com/<handle>"
2. Fetch site:   curl -sL "https://r.jina.ai/<site>"
3. Look for case-insensitive keywords: "minting now", "mint live", "mint open",
   "live now", "claim now", "0x" (contract pattern), "basescan.org",
   "etherscan.io", "0.0" eth price, "free mint", "wl mint", "public mint"
4. Compare ke /home/ubuntu/.hermes/notes/<project>-tracker.txt
   (create kosong kalo gak ada). Track tweet+site MD5 hash separately.
5. Kalo new launch signal detected → ALERT user dengan format:
   ## Status
   🚨 <PROJECT> MINT DETECTED
   ## Action
   - Source: [tweet/site link]
   - Snippet: [first 300 chars match]
   - Contract: [if 0x found]
   ## Blocker
   - User butuh konfirm wallet + chain ETH
   ## Notes
   - <chain> chain, <supply> supply, <team>
6. Update tracker dengan timestamp + last hash.
7. OUTPUT KOSONG kalo gak ada signal (silent watcher).

Skip retweet biasa, fokus launch announcement.'''
)
```

**Why this shape works:**
- `r.jina.ai/<URL>` reader proxy — bypasses X.com login wall and headless-browser sandbox issues. Returns markdown-rendered text including pinned tweet + bio. The native `curl https://x.com/<handle>` gives you a sign-up redirect with no content.
- `enabled_toolsets=['terminal', 'file']` — saves tokens at fire time. No browser, no web_search, no skills loaded.
- `deliver='origin'` — pings the user where they invoked you, NOT silent. Default `local` is the trap.
- Empty stdout when no signal = silent. Pings only on real detection so the user isn't spammed every 10min.
- Tracker file with separate tweet vs site hashes = avoids re-alerting on the same launch tweet across runs.

**Logging side**: each new monitor entry goes into `~/.hermes/notes/fredy-garapan.md` as `[⏸ MONITOR]` so the journal reflects active surveillance. Fields: Source, Type, Status, Twitter/Site links, OpenSea, Wallet, Watcher cron job_id, Tracker file path, Note. See existing entries in that file as templates.

**Interval tuning:**
- Mint date today / claimed-imminent → 10-15min
- Vague "soon" / no date → 30min (saves cron budget; you'd lose 30min on a hit but lose-30min ≪ wasted-runs)
- Confirmed live, just waiting for mint button to appear → 5min and only for the final 1-2 hours before close

**Account-creation / sensitive-action gate**: even when the watcher detects a launch, it MUST NOT auto-execute. Per FREDY_OPS rule 3, paid mint / signMessage / contact-info submission needs explicit user confirm. The watcher's job is detection + ping, full stop. Auto-exec is reserved for the time-windowed launcher above where prereqs (free mint, gasless WL, sufficient burn balance, no 7702 delegation) are pre-validated.

**Cleanup when user drops the project**: removing a watcher is three steps, not one. Empirical (2026-05-15 ZECS): `cronjob(action='remove', job_id=...)` deletes the schedule, but leaves tracker file + garapan.md entry orphaned.
1. `cronjob(action='remove', job_id=...)` — kill the schedule
2. `patch` to delete the `[⏸ MONITOR]` block from `~/.hermes/notes/fredy-garapan.md`
3. `rm -f /home/ubuntu/.hermes/notes/<project>-tracker.txt`

Skip step 2 and the journal accumulates dead entries for projects the user already dropped.

**`deliver='origin'` is sticky to the chat that created the cron.** If the user creates a watcher via Discord and later asks "is Discord off now?" while sitting in Telegram, the watcher will keep firing into the original Discord channel via `gateway live adapter` until the cron is removed or its deliver target is rewritten. Talking to the agent on a different platform does NOT redirect existing crons. To migrate alerts:
- `cronjob(action='update', job_id=..., deliver='telegram:<chat_id>')` — explicit retarget, OR
- `cronjob(action='remove', ...)` then recreate from the new platform so `origin` resolves to it.

**Auditing "is platform X actually off?" — check THREE layers, not one:**
1. Outbound scripts/processes: `pgrep -af '<platform>'`, `ps -ef | grep -i <platform>`
2. systemd user services: `systemctl --user list-units --type=service`
3. **Hermes cron deliver targets + active gateway sessions** — the silent killer:
   ```bash
   hermes cron list 2>&1 | grep -E 'Name:|Deliver:'    # any deliver to <platform>:?
   grep -E "platform=<platform>|delivered to <platform>:" ~/.hermes/logs/agent.log | tail -20
   ```
   Crons with `deliver=origin` resolve at fire time using the cron's stored `origin.platform`/`origin.chat_id` — visible in `~/.hermes/cron/jobs.json` per-job under `"origin": {"platform":"discord", "chat_id":"..."}`.

Layer 3 is what burned us 2026-05-15: I killed all Discord scripts (`discord_errors_tail`, `discord_mirror`, the Discord post helpers) and reported "Discord MATI" with confidence. Meanwhile `abnormalmfers-launch-watcher` (cron `f7be099018c2`, `deliver=origin`, origin pinned to Discord channel `1504868391071252693`) kept firing every 10 min and the gateway's live adapter dutifully delivered each `[SILENT]` / signal alert into Discord. User caught it ~30 min later via "Sebenernya cron nya jalan tapi notifnya ke bot discord". Lesson: a Hermes platform is "off" only when (a) no scripts touch it, (b) no systemd unit talks to it, AND (c) no cron has it as `deliver=` target or `origin.platform`. Skip (c) and you'll lie to the user.

### User-facing alerts via cronjob (NOT terminal sleep)

A bash launcher sleeping in the background CANNOT ping the user — it has no message channel. For "tell me X minutes before the batch opens" alerts, use the cronjob tool with `deliver='origin'`:

```python
cronjob(action='create',
        name='cpunks-bN-2min-alert',
        prompt='Kasih alert ke user: "🔔 BATCH N mulai 2 menit lagi (HH:MM:SS UTC). Hunter T+0s armed."',
        schedule='2026-05-15T10:51:15Z',  # ISO timestamp, batch_start - 2min
        repeat=1,
        deliver='origin',                 # CRITICAL — default is 'local' (silent)
        enabled_toolsets=[])              # no tools needed for a plain message
```

**Pitfall**: `deliver='local'` (the default if you forget the param) means the cron runs silently and the user never sees the alert. Always set `deliver='origin'` for chat-bound notifications. If you forget, `cronjob(action='update', job_id=..., deliver='origin')` fixes it without re-creating.

`enabled_toolsets=[]` keeps the cron lean — no tools loaded, just the message. Saves tokens at fire time.

## Environment management quirks

- **PK files via `/tmp/cpunks.pk` are ephemeral by design** — `umask 077; printf %s '0x...' > /tmp/cpunks.pk`, run, `shred -u`. If a script gets interrupted before shred (Ctrl-C, hermes timeout), the file lingers — verify with `ls -la /tmp/cpunks.pk` before assuming it's gone, and shred manually.
- **PK validity check without leaking content**:
  ```bash
  python3 -c "c=open('/tmp/wallet.pk').read().strip(); h=c[2:] if c.startswith('0x') else c; \
              print(f'len={len(h)} valid={all(x in \"0123456789abcdefABCDEF\" for x in h)}')"
  ```

## Multi-wallet parallelization economics

Tempting to fund N wallets and hunt in parallel. Math usually says don't bother:

- API has BOTH `rate_limit` (per-IP) and `rate_limit_wallet` (per-wallet). Same-IP, multiple wallets ≈ 1.3x throughput, not Nx — the IP floor still caps you.
- Per-wallet cost = `MINT_PRICE + ~0.00005 ETH gas + ~0.00005 ETH transfer-in gas`. Two wallets ≈ 2x capital exposure.
- Break-even hit-rate uplift needs to be > 30% to justify 2x capital risk. Real-world IP-shared parallel hunters get ~30% uplift, so you barely cover the extra cost even on a hit.
- Multi-IP via proxies CAN linearly scale, but proxies cost real money and add an attack surface (proxy operator can replay your /sign API hits). Not worth it for a single drop.

**Decision rule**: if `current_balance >= 2 × (mint_price + gas_buffer + transfer_gas)` AND you have actual proxy/IP isolation, parallel is worth trying. Otherwise stay 1-wallet, fire T+0, accept the variance.

Empirical (CPUNKS 2026-05-15): 0.002349 ETH balance, single mint cost 0.001161, transfer gas 0.00005 — math returned -0.000023 ETH margin for 2-wallet split. Single-wallet was the only safe option.

## Post-campaign wrap-up

When a mint campaign ends (success / failure / batches exhausted / user says "celan aja"), follow this checklist instead of just dropping the working files. Empirical (CPUNKS 2026-05-15): without this checklist the session ends with `/tmp/cpunks*` litter, no journal entry, no Discord visibility — the user has no audit trail and the next campaign starts from scratch.

### 1. Kill ALL hunter and watcher processes

```bash
pkill -9 -f "node mint" 2>&1
pkill -9 -f "_watcher.py" 2>&1
sleep 1
pgrep -af "node mint" || echo "node:clean"
pgrep -af "_watcher" || echo "watcher:clean"
```

Both must report clean. Orphan hunters keep eating per-IP rate-limit budget and waste the FIRST attempt of any future campaign on this machine. See "Kill stale hunters from prior batches BEFORE the next launcher fires" earlier in this skill.

### 2. Capture final ON-CHAIN state (don't trust the server)

The server's `/api/schedule` can rebalance retroactively. Empirical (CPUNKS 2026-05-15 b9): server reduced the published winner count from 1111 → 711 mid-batch, so consumed:1111/1111 from initial fetch later read consumed:711/711 sold:true. On-chain state is ground truth.

```bash
RPC=$(cat /tmp/<chain>.rpc)
WALLET=0x...
CONTRACT=0x...

# Selectors (recompute via keccak, don't trust memory)
# mintedByWallet(address) = 0x0d758111
# balanceOf(address)      = 0x70a08231 (ERC721)
# totalMinted()           = 0x399ec669
# usedMintCodeHash(bytes32) = look up per contract

curl -sS "$RPC" -X POST -H "Content-Type: application/json" --data \
  "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getBalance\",\"params\":[\"$WALLET\",\"latest\"],\"id\":1}"
curl -sS "$RPC" -X POST -H "Content-Type: application/json" --data \
  "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$CONTRACT\",\"data\":\"0x0d758111${WALLET:2}...padded...\"},\"latest\"],\"id\":1}"
```

Some RPCs return `execution reverted` for innocuous view calls (gas estimation differences) — try a second public RPC before assuming the contract is broken.

### 3. Archive reusable artifacts to FREDY_AGENT_HERMES backup

```bash
mkdir -p /home/ubuntu/FREDY_AGENT_HERMES/<project>-<YYYY-MM-DD>
cp /tmp/<project>_node/*.js                /home/ubuntu/FREDY_AGENT_HERMES/<project>-<YYYY-MM-DD>/
cp /tmp/mint_b<winning_batch>.log          /home/ubuntu/FREDY_AGENT_HERMES/<project>-<YYYY-MM-DD>/
cp /tmp/<project>-src/*.sol                /home/ubuntu/FREDY_AGENT_HERMES/<project>-<YYYY-MM-DD>/
```

Keep: scripts that worked, the WINNING hunter log (preserves the actual hit timing), contract sources. Drop: zero-hit hunter logs, watcher logs, scratch debug scripts. Goal is reproducibility, not byte-for-byte preservation.

Per FREDY_OPS backup retention rule (max 2 archives) — if `FREDY_AGENT_HERMES/` already has 2 archives for this project, prune oldest.

### 4. Append to `~/.hermes/notes/fredy-garapan.md`

The journal file has a "Format template" section at the bottom; new entries append above it. Use this structure for a closing entry:

```markdown
## <PROJECT> Mint — Session FINAL (<YYYY-MM-DD>)

### Outcome
- ✅ Batch N: <one-line result with on-chain proof — TX hash, token ID, etc.>
- ❌ Batch M: <reason — 0 hit / unmintable / rate-limit-out>

### Final state
- Wallet: <addr>
- Saldo: X.XXXXXX ETH (verified RPC, untouched / refilled / depleted)
- mintedByWallet: N/MAX
- NFT balanceOf: M (M < N means user already sold some)
- Status: **DONE / partial / failed**

### Salvage attempt log (if applicable)
- What was tried, what the API said, why no recovery

### Artifacts saved
/home/ubuntu/FREDY_AGENT_HERMES/<project>-<date>/
  - script-name.js, key-log.log, contract-source.sol

### Lessons
- 1-3 distilled bullets, actionable for the NEXT campaign
```

### 5. Post Discord report to `#🛠️・garapan`

The user expects a structured report after every garapan, not a casual chat message. **Always specify target explicitly** — `target='discord'` (bare) goes to the home channel; garapan reports go to `discord:#🛠️・garapan`.

Section template (reuse this exactly):

```
**🎯 GARAPAN REPORT — <PROJECT NAME>**
**Tanggal:** <UTC date> — Session FINAL
**Wallet:** `0x...`
**Contract:** `0x...` (chain)

═══════════════════════════════════════
**📊 HASIL**
═══════════════════════════════════════
✅ Batch N — <one-liner with TX hash + token id + sell status>
❌ Batch M — <reason, briefly>

═══════════════════════════════════════
**💰 KEUANGAN**
═══════════════════════════════════════
• Saldo akhir, total spent, total recovered, net P/L
• Slot remaining (mintedByWallet vs MAX_PER_WALLET)

═══════════════════════════════════════
**🔧 STRATEGI & TOOLING**
═══════════════════════════════════════
• What worked (real improvements, not commented-only)
• What bottlenecked (rate limit, race loss, etc.)

═══════════════════════════════════════
**📚 LESSONS**
═══════════════════════════════════════
• 3-5 bullets — distilled, actionable

═══════════════════════════════════════
**📁 ARTIFACTS** (saved to `/home/ubuntu/FREDY_AGENT_HERMES/<project>-<date>/`)
═══════════════════════════════════════
• Files preserved

**Status:** ✅ DONE / ⚠️ partial / ❌ failed — <one-line tl;dr>
```

Use `═` lines and emoji-headed sections — user reads on Discord mobile, scannable structure matters. Don't truncate "what bottlenecked" into vague phrases like "lost races" — name the actual mechanism (rate-limit floor, race timing, server cache TTL, etc.) so the report has audit value.

### 6. Pending decisions go LAST, NOT in the report

Sensitive cleanup (`/tmp/<project>.pk` shredding, encrypted backup of seed material, optional working-dir purge) is the user's call per FREDY_OPS rule 3 (sensitive on-chain action confirmation). After posting the Discord report, present the open questions in plain text in chat:

- "PK file masih di `/tmp/<project>.pk` — shred permanen, atau backup encrypted ke FREDY_AGENT_HERMES?"
- "Working dir `/tmp/<project>_node/` udah di-archive, mau hapus original?"

Do NOT auto-shred PK files. Do NOT auto-purge working dirs that haven't been backed up yet.

## Past lessons

- **2026-05-15 CPUNKS session FINAL wrap-up**: campaign closed after b9 sold out (711/711 server-rebalanced). Without an explicit wrap-up checklist the session would have ended with `/tmp/cpunks*` litter, no journal entry, and a casual Discord message. User's flow expects: kill processes → archive to FREDY_AGENT_HERMES → append to fredy-garapan.md → post structured Discord report to `#🛠️・garapan` → present pending PK/cleanup decisions in chat. Missed this once = session has no audit trail and next campaign starts blind. The "Post-campaign wrap-up" section above is the canonical sequence.
- **Same session, b3 leftover salvage attempt**: HIT mintCode `0xc4c4...6ca2` from batch 3 (~4 hours stale by attempt time), on-chain `usedMintCodeHash=0`, signer key unchanged → `/sign-mint-code` still returned `HTTP 404 mint_code_not_found`. Zero gas burned (sign rejected before broadcast). Reinforces "leftover mintCodes from prior batches are unmintable" rule above.

- **2026-05-15 CPUNKS batch 3**: Wallet-burn `0xcD23...5881` had 7702 delegate `0x1d37...20be` (1003 bytes code, no `onERC721Received`). Tx broadcast pake correct mintCode + valid signature + correct price → reverted with `ERC721InvalidReceiver(0xcD23...5881)`. Cost ~0.001144 ETH gas (mint price refunded by EVM revert). Skill ini lahir dari kasus itu.
- **Same session, earlier mistake**: gua trace pake `debug_traceCall` dengan typo di `value` field → got `WrongPrice()` selector → spent 5 minutes investigating non-existent pricing bug. Lesson: always copy from `eth_getTransactionByHash`.
- **Same session, output flush trap**: hunter Node script jalan di Hermes background, output `process.stdout.write("...\r")` ga keluar di `process.log`/`process.poll`. Process keliatan idle padahal hunting normal. Fix: redirect to file with `exec node mint.js > /tmp/mint.log 2>&1` and `tail -f` instead of relying on Hermes pipe capture, atau switch to `console.log`.
- **Same session, batch decision**: batch 4 sisa 13/10000 winners (0.13%) — 50+ attempts straight miss. Lesson encoded as the 1% hit-rate bail rule above.
