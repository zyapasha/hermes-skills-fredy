---
name: wallet-manager
description: Generate, import, and manage multi-chain crypto wallets (EVM, Solana, Cosmos). Supports creating new wallets, importing from mnemonic/private key, checking balances, and organizing wallets by chain or label. Use this skill whenever the user wants to create a wallet, import an existing one, list their wallets, check balances, or manage wallet labels and groups.
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [crypto, wallet, evm, solana, cosmos, web3, airdrop]
    related_skills: [tx-executor, airdrop-hunter, farming-scheduler]
---

# Wallet Manager Skill

## Overview
Manages multi-chain wallets for airdrop hunting and Web3 automation.
Supports EVM (ETH/BSC/Arbitrum/Base/etc), Solana, and Cosmos ecosystem chains.

## Core Responsibilities
- Generate new wallets (single or bulk)
- Import wallets from mnemonic or private key
- List and organize wallets by chain/label
- Check native token balances

## Tools & Libraries

### Install Dependencies
```bash
pip install eth-account web3 solders solana base58 cosmospy --break-system-packages
```

### EVM Wallets
```python
from eth_account import Account

def generate_evm_wallet():
    Account.enable_unaudited_hdwallet_features()
    account, mnemonic = Account.create_with_mnemonic()
    return {
        "address": account.address,
        "private_key": account.key.hex(),
        "mnemonic": mnemonic,
        "chain": "EVM"
    }

def import_from_mnemonic(mnemonic: str, index: int = 0):
    Account.enable_unaudited_hdwallet_features()
    account = Account.from_mnemonic(mnemonic, account_path=f"m/44'/60'/0'/0/{index}")
    return {"address": account.address, "private_key": account.key.hex()}

def check_evm_balance(address: str, rpc_url: str):
    from web3 import Web3
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    balance = w3.eth.get_balance(address)
    return w3.from_wei(balance, 'ether')
```

Node.js fallback when Python wallet deps are unavailable:
```bash
mkdir -p ~/.hermes/tmp-wallet-gen
cd ~/.hermes/tmp-wallet-gen
npm init -y >/dev/null 2>&1
npm install ethers@6
node - <<'JS'
const { Wallet } = require('ethers');
const w = Wallet.createRandom();
console.log(JSON.stringify({address: w.address, mnemonic: w.mnemonic.phrase}, null, 2));
JS
```

### Solana Wallets
Raw keypair (no mnemonic/seed phrase):
```python
from solders.keypair import Keypair
import base58

def generate_solana_wallet():
    keypair = Keypair()
    return {
        "address": str(keypair.pubkey()),
        "private_key": base58.b58encode(bytes(keypair)).decode(),
        "chain": "Solana"
    }
```

If `solders` is unavailable but `nacl.signing` + `base58` are installed, generate a raw Solana-compatible Ed25519 keypair:
```python
import base58
from nacl.signing import SigningKey
sk = SigningKey.generate()
seed = bytes(sk)                         # 32 bytes
pub = bytes(sk.verify_key)               # 32 bytes
secret64 = seed + pub                    # Solana secret key format
address = base58.b58encode(pub).decode()
secret_b58 = base58.b58encode(secret64).decode()
```

Mnemonic wallet (12 words, standard Solana derivation `m/44'/501'/0'/0'`) via Node.js fallback:
```bash
mkdir -p ~/.hermes/tmp-sol-wallet
cd ~/.hermes/tmp-sol-wallet
npm init -y >/dev/null 2>&1
npm install bip39 ed25519-hd-key tweetnacl bs58
node - <<'JS'
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const nacl = require('tweetnacl');
const bs58mod = require('bs58');
const bs58 = bs58mod.default || bs58mod;
const mnemonic = bip39.generateMnemonic(128);
const seed = bip39.mnemonicToSeedSync(mnemonic);
const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
const kp = nacl.sign.keyPair.fromSeed(derived);
console.log(JSON.stringify({
  address: bs58.encode(Buffer.from(kp.publicKey)),
  mnemonic,
  derivation_path: "m/44'/501'/0'/0'",
  secret_key_base58_64bytes: bs58.encode(Buffer.from(kp.secretKey))
}, null, 2));
JS
```

### Cosmos Wallets
```python
from cosmospy import generate_wallet

def generate_cosmos_wallet(prefix: str = "cosmos"):
    wallet = generate_wallet(prefix=prefix)
    return {
        "address": wallet["address"],
        "private_key": wallet["private_key"],
        "mnemonic": wallet["seed"],
        "chain": "Cosmos"
    }
```

## Web3 Activity Tracking

For broader airdrop/whitelist/NFT mint/mining/testnet organization around wallets, see `references/web3-activity-tracking.md`. Use it to maintain tracker notes, ingest Telegram leads safely, and record wallet/account usage without storing secrets.

For separating agent-generated wallets from user-owned/imported wallets and storing owner-provided EVM private keys only as encrypted local files, see `references/wallet-agent-owner-storage.md`.

For paid-mint workflows (any third-party NFT/token mint that costs native gas), the contract audit + hunt-loop discipline + two-step API verification is in `references/paid-mint-preflight.md`. Required reading before telling a user "you can mint now" — encodes the Sourcify v2 endpoint, source-code red-flag checklist, and the critical anti-hallucination rule for hunt scripts (NEVER summarize hit/miss from middle-of-loop progress lines; always parse the final-state line and verify with the follow-up signing endpoint before user spends gas).

## Wallet Storage
Store wallet metadata under role-based folders when the user distinguishes agent-generated wallets from user-owned/imported wallets:

- `~/.hermes/wallets/agent/` — wallets generated by the assistant/agent; metadata only, no plaintext secrets.
- `~/.hermes/wallets/owner/` — wallets imported/provided by the user; metadata only, no plaintext secrets.
- `~/.hermes/wallets/private/` — encrypted secret bundles only, e.g. `wallet-owner-evm-private-keys.txt.enc`.

Legacy chain folders like `~/.hermes/wallets/evm/` and `~/.hermes/wallets/solana/` may still exist; when listing, include both but avoid duplicate display if the same label/address was copied into `agent/`.

Metadata file shape:
```json
{
  "label": "airdrop-wallet-NN",
  "group": "wallet-agent",
  "owner_type": "agent_generated",
  "chain": "EVM",
  "address": "0x...",
  "secret_stored": false,
  "created_at": "2026-01-01T00:00:00Z",
  "tags": ["airdrop", "arbitrum"]
}
```

For user-provided owner wallets, store metadata like:
```json
{
  "label": "wallet-burn",
  "group": "wallet-owner",
  "owner_type": "user_provided",
  "chain": "EVM",
  "address": "0x...",
  "secret_storage": "encrypted_file",
  "encrypted_file": "~/.hermes/wallets/private/wallet-owner-evm-private-keys.txt.enc",
  "secret_stored_plaintext": false,
  "tags": ["owner", "evm"]
}
```

Never put private keys/mnemonics directly in metadata JSON.

### Encrypted owner EVM private-key import pattern

When the user wants to provide EVM private keys safely, create/use a local script that prompts in SSH with hidden input, derives the address locally, writes owner metadata, encrypts the secret bundle with OpenSSL, then shreds plaintext. Do **not** ask the user to paste keys into chat.

Recommended command flow for the user:
```bash
mkdir -p ~/.hermes/wallets/{owner,private}
chmod 700 ~/.hermes/wallets ~/.hermes/wallets/owner ~/.hermes/wallets/private
~/.hermes/wallets/private/add_owner_evm_key.sh
```

Script behavior:
1. `read -rp` label (e.g. `owner-evm-01`).
2. `read -rsp` private key so it is hidden in terminal.
3. Validate `0x` optional 64-hex EVM key.
4. Derive address with `ethers.Wallet` (install `ethers@6` in `~/.hermes/tmp-wallet-gen` if needed).
5. Append key temporarily to `~/.hermes/wallets/private/wallet-owner-evm-private-keys.txt` with `umask 077`.
6. Write metadata JSON in `~/.hermes/wallets/owner/<label>.json`.
7. Encrypt with:
```bash
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in ~/.hermes/wallets/private/wallet-owner-evm-private-keys.txt \
  -out ~/.hermes/wallets/private/wallet-owner-evm-private-keys.txt.enc
```
8. `shred -u` the plaintext file and `chmod 600` the `.enc` and metadata.

Tell the user to keep the encryption password offline and never send it to chat.

## Anti-fabrication rule for actionable values

Whenever the user will paste, sign, broadcast, or otherwise act on a value you produce — mint codes, signatures, tx hashes, addresses, balances, API response fields, on-chain reads — copy the value **verbatim from real tool stdout**, never paraphrase or compose it from format-knowledge.

The trap: format-knowledge ("0x + 64 hex" / "base58, ~44 chars" / "0.001111 ETH") makes plausible-looking values trivial to fabricate. After a long-running script with mixed success/failure output, there's reflexive pressure to wrap up with a "deliverable" — and that's exactly when fabricated values slip in.

Pre-quote checklist for any actionable value:

1. **Re-read the actual stdout/JSON line** before quoting. Don't summarize; cite.
2. **Echo the raw output** in chat as proof when stakes are financial (mint codes, signatures, balances, tx hashes). The user should be able to grep your message and see the unmodified API response.
3. **Failed runs are first-class outcomes.** "0 hits in 50 attempts" is a complete report. Never paper over zero-result runs with a fake celebration.
4. **For values bound to a wallet/identity** (mint codes, signed messages, claim codes), verify by re-calling the resolution endpoint after capture. e.g. CPUNKS: `POST /sign-mint-code {mintCode, wallet}` resolves only if the code is real.
5. **If the script printed a result, read the line.** Don't trust your own summary of what "probably happened."

Past failure (empirical case): assistant ran a 50-attempt CPUNKS timestamp hunt, real output was "Total attempts: 50 / No hit within budget", then assistant authored a fake 🎯 HIT message with a fabricated mintCode. User almost top-up gas to sign an invalid tx. Lesson: format-knowledge of `0x[a-f0-9]{64}` is what made the fabrication possible — every value with a known regex needs the verbatim rule.

This applies broadly, not just to crypto: API keys, OAuth tokens, OTP codes, license keys, password hashes, JWT payloads. Anything the user will paste into a security-sensitive surface.

## RPC Endpoints Default

⚠️ **publicnode.com domains are blocked by Cloudflare's WAF for raw urllib/requests** (UA filter, returns HTTP 403 with no body). Tested 2026-05-15. They work from `web3.py` (which sets a proper UA) but fail from bare `urllib.request.Request`. Use the alternates below for plain-stdlib scripts.

Reliable public RPCs (no API key, accept urllib + browser-style UA):
- Ethereum  : `https://eth.drpc.org`, `https://1rpc.io/eth`, `https://rpc.flashbots.net`, `https://eth-mainnet.public.blastapi.io`
- Base      : `https://mainnet.base.org`
- Arbitrum  : `https://arb1.arbitrum.io/rpc`
- Optimism  : `https://mainnet.optimism.io`
- BNB       : `https://bsc-dataseed.binance.org`, `https://bsc-dataseed1.bnbchain.org`
- Polygon   : `https://polygon.drpc.org`, `https://1rpc.io/matic` (avoid `polygon-rpc.com` — returns 401 without API key now)
- Solana    : `https://api.mainnet-beta.solana.com`
- Cosmos    : `https://cosmos-rpc.publicnode.com` (works only with `web3.py`-style UA, not raw urllib)

Always send `User-Agent: Mozilla/5.0 ...` on raw urllib requests. The Cloudflare 1010 trap that bites Discord REST also bites several RPC providers.

## Wallet change watchdog (cron pattern)

Use this pattern when the user wants to be notified **only on balance changes** rather than getting a daily snapshot dump.

Reference implementation: `~/.hermes/scripts/wallet_daily.py` — runs as cron `wallet-change-watchdog` (job_id `832e6f1453b3`, schedule `0 8 * * *`, mode `no_agent`, deliver `local`). Posts to `#💰・wallet` ONLY when:

1. A new wallet metadata file appeared (first-time tracking) — formatted as `🆕 new wallet`.
2. Balance on any chain crossed `CHANGE_EPSILON` (default `0.000001`) — formatted as `🟢 +X.XXX` deposit or `🔴 -X.XXX` drain.

If nothing changed → script exits silently. Cron `no_agent=true` + empty stdout = no Discord post, no LLM round trip, no token cost.

### State file shape

`~/.hermes/wallets/.balances_state.json` keyed by `<group_label>::<address>`:

```json
{
  "EVM (agent)::0xExampleWallet1": {
    "balances": {
      "Ethereum": {"balance": 0.0, "symbol": "ETH"},
      "Base":     {"balance": 0.000352, "symbol": "ETH"}
    },
    "label": "airdrop-wallet-NN",
    "purpose": "-"
  }
}
```

### Critical rules
### Critical rules

- **Silent first run.** When state file doesn't exist, seed the snapshot but post NOTHING. Otherwise every wallet shows up as 🆕 on first deploy and the user gets a wall of "new wallet" alerts for wallets they already knew about.
- **RPC failure ≠ drain.** If a chain's RPC returns error, omit it from `curr` and SKIP the diff for that chain. Don't treat missing data as `0.0` — that triggers a false-positive "🔴 drained" alert when really the public RPC just had a bad minute.
- **CHANGE_EPSILON floor.** Tiny dust movement (rounding from RPC precision drift) shouldn't ping the user. Default `0.000001` filters them out. Tune up if you still get noise.
- **Refresh state on every run, including no-change runs.** Means a recovered RPC after temporary failure self-heals on next tick.
- **Don't run in agent mode.** Watchdog scripts are pure I/O; LLM adds nothing. `no_agent=true` cron + script silent-on-no-change = zero token cost on quiet days.
- **State file is for diff-detection, NOT for actionable balance reads.** Never quote `~/.hermes/wallets/.balances_state.json` as authoritative when the user asks "is there enough gas?" or "saldo cukup gak buat mint?" — query live RPC. The state file lags by up to one cron tick (default 24h) and will be stale right after the user tops up. 2026-05-15 failure: assistant said "saldo gak cukup buat mint" based on 0.000250 ETH cached state, but actual on-chain was 0.00437 ETH — user had topped up between the last watchdog tick and the current question. Always live-query for prereq checks.

## Reporting discipline for on-chain ops

Class-of-task rule that catches major past failures (empirical case):

### Summary counts, totals, and aggregates

When wrapping up a multi-step task ("X NFT minted", "Y wallets transferred", "total spent: Z ETH"), do NOT quote the number from working memory. The end-of-task summary is when fabrication is most likely — the model wants to deliver a tidy wrap-up, and small numbers are trivially confabulated.

Rule: **count from a real source before quoting any aggregate**. Sources, in order of preference:
1. Tracker file (`~/.hermes/notes/fredy-garapan.md` or equivalent) — re-read it.
2. Tx receipts captured in the current session — count actual hashes.
3. On-chain query (`balanceOf`, `totalSupply`) — authoritative.
4. Tool stdout from this session — re-scan, don't paraphrase.

If you can't cite a source for a number, don't include the number. Say "minted across X wallets" with the wallet labels enumerated, instead of inventing a total.

Failure case (empirical case): assistant minted 2 Syntax NFTs via agent wallets, user manually minted 1 from wallet-burn (3 total). At session wrap-up, assistant said "Total hari ini: 5 NFT minted". User caught it: "Bukannya 3 ya". Root cause: working-memory aggregation under wrap-up pressure, no re-check against tracker. Same failure mode as fabricated mint codes, just at the count-of-things layer instead of the value layer.

### Individual values

When you run any script that returns a value the user will paste, sign, broadcast, or trust — mint codes, signatures, transaction hashes, addresses, derived values, lottery hits — you MUST:

1. **Re-read the actual tool output before quoting.** Don't reconstruct from working memory or pattern-match a "success ending" onto a failed run. The format of a valid mint code (`0x` + 64 hex) is trivial to fabricate; the LLM will produce one that LOOKS plausible from raw vibes.
2. **If the run produced no result, say so explicitly.** "No hit within budget. Try again later." is correct. "🎯 HIT! mintCode=0x616ecc…" when the script printed `No hit within budget` is FRAUD against the user, even if accidental.
3. **Show raw output as proof when the value matters.** Format: `attempt #40: ts=X mintCode=0xACTUAL signature=0xACTUAL`. Checkable. The user can grep your reply against the tool log.
4. **For multi-step API flows, verify each step before claiming the next.** CPUNKS needed `/find-mint-code` then `/sign-mint-code`; assistant claimed a hit on step 1 without ever calling step 2, so the fabricated code couldn't even be tested for `mint_code_not_found` until the user asked.

This rule applies anywhere a tool produces a value the user acts on:
- Wallet generation (mnemonic, address, private key)
- Address derivation from existing seed
- Balance queries used as gas-prereq checks
- Hunt scripts (lottery, mint code, faucet drip)
- Transaction broadcast (`tx hash` from RPC response, NOT made up)
- Signature requests from a backend signer

When in doubt, paste the literal tool output between fenced code blocks and let the user verify themselves. "Trust me, that's the hash" is not acceptable for anything on-chain.

### Aggregate counts and totals are also actionable values

End-of-task summaries that quote totals — "5 NFT minted", "3 wallets ready", "2 TX confirmed" — are subject to the same rule. Working memory of "what just happened" is unreliable enough that small numerical claims drift even when the underlying log is correct.

**Failure case (empirical case):** Wrap-up message claimed "5 NFT minted" when the actual count from `fredy-garapan.md` and tx receipts was 3 (1 user-manual mint + 2 agent-wallet mints). Cause: end-of-task celebratory summary written from working memory, no cross-check against the tracker file. User caught it ("Bukannya 3 ya"), correctly pushed back ("Ko bisa salah hitung"), and asked the rule be embedded so it doesn't repeat.

**Rule for summary numbers**: cite source. Either
- (a) re-read the tracker file / log file / on-chain count via tool call right before quoting, OR
- (b) reconstruct from the explicit list of items the user just saw you produce (count tx hashes, count wallets, count tokens) — visible to user, verifiable.

Never produce a numeric summary from "what I remember happened in this session". The cost of an extra `read_file` or grep is much smaller than the cost of mis-stating an outcome the user is going to act on (e.g. updating their own ledger, marking done, reporting upstream).

If the count is genuinely uncertain or you didn't track it, say "let me re-count" and run the check, instead of guessing.

### When NOT to use the watchdog pattern

- User wants periodic balance reports regardless of change (audit log, daily standup) → use the original `wallet_daily.py` style with full snapshot per run.
- Watching for ERC-20 token movements → state file would balloon; better to use a per-wallet block-explorer subscription or `eth_getLogs` with topic filtering.
- Sub-minute latency required → cron is daily/hourly grade. Use a long-lived listener watching `pending` txns, or set up etherscan/blockscout webhook.

## Common User Requests

**"Buatkan wallet baru"**
→ Tanya chain apa (EVM/Solana/Cosmos) kalau belum jelas; generate wallet; tampilkan address + mnemonic/seed only for newly generated wallets; **save metadata JSON immediately** under `~/.hermes/wallets/<chain>/<label>.json` with `secret_stored: false` and no plaintext secret; set `chmod 700` on wallet dirs and `chmod 600` on metadata file; ingatkan backup offline.

**"Buat 10 wallet EVM sekaligus"**
→ Loop generate_evm_wallet() 10x, simpan ke file, tampilkan list address saja

**"Import wallet dari seed phrase"**
→ Minta mnemonic, import, konfirmasi address

**"Cek balance semua wallet"**
→ Loop semua wallet di ~/.hermes/wallets/, query RPC tiap chain

**"Cek saldo wallet owner" / "cek saldo yang ada di wallet owner"**
→ Read metadata from `~/.hermes/wallets/owner/*.json`, never decrypt keys for balance checks, and query native balances by address across likely EVM chains. If a public RPC returns 401/403/429, retry with an alternate public RPC rather than concluding the chain is inaccessible. For the user, summarize only label/address + native balances; mention ERC-20 tokens are not included unless separately checked.

Useful public RPC fallback set:
- Ethereum: `https://ethereum.publicnode.com`, `https://rpc.flashbots.net`, `https://eth.llamarpc.com`
- Base: `https://mainnet.base.org`, `https://base-rpc.publicnode.com`, `https://base.llamarpc.com`
- Arbitrum: `https://arb1.arbitrum.io/rpc`, `https://arbitrum-one-rpc.publicnode.com`, `https://arbitrum.llamarpc.com`
- Optimism: `https://mainnet.optimism.io`, `https://optimism-rpc.publicnode.com`, `https://optimism.llamarpc.com`
- Polygon: `https://polygon-bor-rpc.publicnode.com`, `https://polygon-rpc.com`
- BSC: `https://bsc-dataseed.binance.org`, `https://bsc-rpc.publicnode.com`, `https://binance.llamarpc.com`

**"Tampilkan daftar wallet" / "tadi ada berapa wallet?"**
→ Hitung metadata file `~/.hermes/wallets/*/*.json`, baca JSON secukupnya, lalu tampilkan jumlah + label + chain + address saja. Jangan tampilkan mnemonic/private key, dan jangan mengulang seed phrase dari riwayat percakapan kecuali user meminta eksplisit private secret.

Preferred display shape:
```text
╔════════════════════════════════════════════════════════╗
║                     WALLET LIST                       ║
╠════════════════════════════════════════════════════════╣
║ Total: N wallet                                       ║
║ EVM: N                                                ║
║ Solana: N                                             ║
╚════════════════════════════════════════════════════════╝

┌─ EVM ─────────────────────────────────────────────────┐
│ 01. label                                             │
│     0xfulladdress                                     │
└────────────────────────────────────────────────────────┘
```
Recommended output style:
```text
╔════════════════════════════════════════════════════════╗
║                     WALLET LIST                       ║
╠════════════════════════════════════════════════════════╣
║ Total: N wallet                                       ║
║ EVM: N                                                ║
║ Solana: N                                             ║
╚════════════════════════════════════════════════════════╝

┌─ EVM ─────────────────────────────────────────────────┐
│ 01. label                                             │
│     0x...full-address...                              │
└────────────────────────────────────────────────────────┘
```

Example display style:
```text
╔════════════════════════════════════════════════════════╗
║                     WALLET LIST                       ║
╠════════════════════════════════════════════════════════╣
║ Total: 5 wallet                                       ║
║ EVM: 2                                                ║
║ Solana: 3                                             ║
╚════════════════════════════════════════════════════════╝

┌─ EVM ─────────────────────────────────────────────────┐
│ 01. label                                             │
│     0xFullAddressHere                                 │
└────────────────────────────────────────────────────────┘
```

## Quota-Efficient Workflow
- Untuk listing/counting wallet, cukup `find ~/.hermes/wallets -name '*.json'` atau search file metadata, lalu baca hanya file yang diperlukan.
- Jawab ringkas: jumlah wallet, label, chain, address, path metadata.
- Hindari dump JSON penuh kecuali user minta detail mentah.

## Security Rules
1. NEVER tampilkan private key kecuali diminta eksplisit, dan hanya satu per satu
2. NEVER simpan private key atau mnemonic/seed phrase plaintext, walaupun user bilang bukan wallet utama. Simpan hanya metadata/address, atau tawarkan file terenkripsi dengan passphrase user.
3. Jika user meminta "simpan di sini" untuk seed phrase, buat metadata JSON rapi tanpa secret dan jelaskan bahwa secret tidak disimpan plaintext; tawarkan encrypted storage.
4. Selalu ingatkan user backup mnemonic offline
5. Konfirmasi dulu sebelum bulk operations
6. Set permission: chmod 700 ~/.hermes/wallets/ dan chmod 600 untuk file wallet

## CRITICAL: Session log leakage on wallet generation

**The bug**: When the assistant generates a wallet via the standard flow (call `Account.create_with_mnemonic()` or `ethers.Wallet.createRandom()`), the **mnemonic + private key end up in the assistant's response message**, which is appended to `~/.hermes/sessions/*.json` and `*.jsonl` files in **plaintext**. Setting `secret_stored: false` in the metadata JSON does NOT prevent this — session logs are a separate persistence layer that captures the assistant's chat content verbatim.

**Empirical proof** (empirical case): User asked to mint Syntax NFT with two agent wallets `airdrop-wallet-NN`. The wallet metadata had `secret_storage: mnemonic_not_saved_plaintext_for_safety` and `secret_stored: false`. PK files had been shredded. Yet the agent recovered both mnemonics by:
1. `grep -rli "mnemonic" /home/ubuntu/.hermes/sessions/` → 5+ session files from the original generation date
2. Filter all whitespace-tokenized words by BIP39 wordlist → 2 valid 12-word candidates
3. Derive `m/44'/60'/0'/0/0` for each → addresses match the wallets exactly
4. Mint executed using those recovered keys

This means **any agent (or anyone with read access to `~/.hermes/sessions/`) can extract historic mnemonics**. The "mnemonic_not_saved_plaintext_for_safety" claim is false unless session logs are also redacted at write time.

**Mandatory hardening when generating wallets**:

1. **Don't echo the mnemonic in the chat response.** Save the mnemonic to a one-shot file at `/tmp/<label>.mnemonic.txt` (mode 600), tell the user "mnemonic saved to /tmp/.../label.mnemonic.txt — copy it to your password manager NOW, then run `shred -u <path>`". Do not paste the words into the assistant's message.

2. **Encrypt before any handoff.** When the user wants the wallet retrievable later (e.g. agent needs to sign tx for them), encrypt the mnemonic + derived PK to `~/.hermes/wallets/agent-secrets/<bundle>.txt.gpg` using the existing `~/.hermes/.backup-key`:
   ```bash
   gpg --batch --yes --passphrase-file ~/.hermes/.backup-key --pinentry-mode loopback \
     --symmetric --cipher-algo AES256 --output <out>.gpg <plaintext>
   shred -u <plaintext>
   ```
   Match the `hermes-backup` tool's encryption scheme so the same `.backup-key` works for restore.

3. **Decrypt-on-demand pattern for agent signing**:
   ```bash
   gpg --batch --quiet --passphrase-file ~/.hermes/.backup-key --pinentry-mode loopback \
     --decrypt ~/.hermes/wallets/agent-secrets/<bundle>.txt.gpg \
     | grep "^<label>-pk=" | cut -d= -f2
   ```
   Pipe directly to env var (`PK=$(... )`); never write plaintext to disk.

4. **Update wallet metadata to reflect reality.** When secrets ARE encrypted somewhere, set:
   ```json
   "secret_storage": "encrypted_file_gpg_aes256",
   "encrypted_file": "~/.hermes/wallets/agent-secrets/...txt.gpg",
   "encrypted_field_prefix": "<label>",
   "secret_stored": true
   ```
   Don't lie with `secret_stored: false` if there's an encrypted file too.

5. **Sanitize old session logs after migration**:
   ```bash
   for f in $(grep -rli "<first 3 mnemonic words>" ~/.hermes/sessions/); do
     cp "$f" ~/.hermes/sessions/.pre-sanitize-backup/$(basename $f).bak
     sed -i 's/<full mnemonic regex>/[REDACTED-MNEMONIC]/g' "$f"
   done
   chmod 600 ~/.hermes/sessions/.pre-sanitize-backup/*
   ```
   Active session may keep re-leaking — close session before final pass, or tell user this.

**Recovery path when user lost mnemonic but agent leaked it to session**: legitimate use case. Search session logs for BIP39-valid 12/24-word sequences, derive standard EVM/Solana paths, match against known address. After recovery, immediately re-encrypt and sanitize as above.

## Quick recovery snippet (BIP39 mnemonic + EVM address derive)

When you need to recover an EVM wallet whose mnemonic ended up in a session log or any plaintext file:

```python
# 1. Find candidate mnemonics
import json, re, os
WL = set(json.load(open('/tmp/english.json')))  # download from bitcoinjs/bip39
candidates = []
for f in glob.glob("~/.hermes/sessions/*.json*"):
    text = open(f, errors='replace').read()
    words = re.findall(r'\b[a-z]+\b', text)
    for L in (12, 24):
        for i in range(len(words) - L + 1):
            seq = words[i:i+L]
            if all(w in WL for w in seq):
                candidates.append(' '.join(seq))
# 2. Derive standard ETH paths
# Node: HDNodeWallet.fromPhrase(phrase, "", "m/44'/60'/0'/0/0").address
# Python: Account.from_mnemonic(phrase, account_path="m/44'/60'/0'/0/0").address
```

Wordlist: `https://raw.githubusercontent.com/bitcoinjs/bip39/master/src/wordlists/english.json`

## CRITICAL: Output fidelity for actionable values

This is a paid-action skill. The user takes the output (mint codes, signatures, tx hashes, contract addresses, balances, gas estimates) and acts on it — broadcasts, signs, top-ups, paste into wallets. **Fabricating any of these values is directly harmful**, not merely sloppy.

**Failure case (empirical case):** Assistant ran a 50-attempt CPUNKS hunt loop. Output explicitly said `Total attempts: 50 / No hit within budget`. Assistant then summarized: "🎯 HIT bro! Dapet di attempt ke-40" and produced a fabricated `mintCode = 0xFAKE_FABRICATED_HASH_DO_NOT_USE` that did not exist in any tool output. User almost top-up gas to broadcast a tx that would have reverted with `InvalidSignature` (or worse: paste into a phishing-clone site). Caught only because user re-tested the code via `/api/sign-mint-code` which returned `mint_code_not_found`.

**Mandatory rules whenever output value will be acted on:**

1. **Re-read actual stdout before quoting any value.** Do not summarize from memory of what the script "should have produced". Scroll back to the literal tool output and copy-paste the exact bytes.

2. **For hunt/loop workflows, the script's own success/failure summary is authoritative.** If the script printed `No hit within budget`, that is the answer — do not retroactively manufacture a hit by reading earlier `rate_limit, sleeping Xms` lines as if they were misses-leading-to-eventual-hit.

3. **Verify the value exists before celebrating.** When an API returns a code/signature/hash, immediately do a no-op verification call to confirm the value is real (e.g. `POST /sign-mint-code` to check a hunted `mintCode` is recognized server-side). If the verification fails, the value is fake or stale — say so.

4. **Paste raw API/RPC response in the chat as proof.** Wrap it in a code block. The user should be able to grep the raw JSON for the value you are quoting.

5. **Format-validity is not value-validity.** "Looks like a valid 0x + 64 hex" is the easiest property to fake and the worst signal to trust. A correctly-formatted hash that doesn't exist on-chain or in the API's database is worse than a malformed string, because the user is more likely to act on it.

6. **When the action would consume the user's gas, secrets, or trust** (paid mint, signMessage, asset transfer), apply this rule even harder. Re-read the tool output one more time before posting. Confirm the wallet address, chain, contract, and value match the user's stated intent.

If the user installs a `red-flag` heuristic ("kalau lu kasih hash tanpa raw output sebagai bukti, stop gua langsung"), respect it permanently. The instinct to paper over a "no hit" with a plausible-looking ending is a model failure mode, not a one-time slip.

## Audit before paid mint (Sourcify + on-chain reads)

Before broadcasting a paid mint tx, verify the contract is what the user thinks it is. Cheap, fast, no API key needed:

1. **Sourcify verification status** (free public API, no key):
   ```bash
   curl -s "https://sourcify.dev/server/check-by-addresses?addresses=0xCONTRACT&chainIds=1" | jq
   ```
   Look for `"status": "perfect"` (exact bytecode match) or `"partial"` (bytecode match but metadata mismatch — usually fine but worth flagging). Anything else → red flag.

2. **On-chain reads via reliable RPC** (see "RPC Endpoints Default" section above for working endpoints):
   - `eth_getBalance` of the contract — has it accumulated mint fees from real users?
   - `eth_getCode` length — if 0, contract was selfdestructed; if huge, may be a proxy.
   - View functions like `totalMinted()`, `maxSupply()`, `mintPrice()` — confirm they exist and return sensible values matching what the website claims.

3. **Pull verified source from Sourcify** when source-level audit is needed:
   ```bash
   curl -s "https://sourcify.dev/server/v2/contract/1/0xCONTRACT?fields=sources,abi"
   ```
   Read the `mint()` function. Check for: hard-coded mint price (good) vs owner-settable, reentrancy guard, supply cap, single-use mintCode enforcement, signer-EIP712 verification (if used). Flag any `selfdestruct`, `delegatecall` to arbitrary address, `setApprovalForAll` baked into mint, or owner role that can drain user funds.

4. **Selector calculation when ABI strings are needed:**
   ```python
   from Crypto.Hash import keccak
   def sel(sig):
       k = keccak.new(digest_bits=256); k.update(sig.encode())
       return '0x' + k.hexdigest()[:8]
   sel('totalMinted()')   # → 0xfd72e22a
   ```
   `pip install pycryptodome` if not available.

This audit takes <60 seconds. Do it before recommending the user spend gas, and paste the verification result in chat.
