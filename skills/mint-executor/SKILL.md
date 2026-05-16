---
name: mint-executor
description: One-shot NFT mint across all agent wallets in parallel. Auto chain detect, function probe, gas budget, broadcast, and consolidate to wallet-burn. Use when user says "mint <contract>" or forwards a free/low-cost mint garapan and wants fast multi-wallet execution.
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [crypto, nft, mint, evm, fcfs, garapan]
    related_skills: [wallet-manager, evm-mint-preflight, eip7702-erc721-mint-check]
---

# mint-executor

🌐 **English** · [Bahasa Indonesia](SKILL.id.md)

## When to use

User wants to mint an NFT/token across multiple agent wallets fast. Triggers:
- "mint 0xabc..."
- Garapan ping with a contract address + free/low gas
- Anything where speed matters (FCFS) and contract is already audited or trivially verifiable

## Quick start

```bash
mint <contract>                    # parallel mint all agent wallets, auto-consolidate to wallet-burn
mint <contract> --dry              # preflight only, no broadcast
mint <contract> --qty=2            # mint 2 per wallet
mint <contract> --chain=base       # skip chain detection
mint <contract> --fn=mint          # force function (skip auto-probe)
mint <contract> --wallets=01,02    # filter to specific wallets by suffix
mint <contract> --no-consolidate   # leave NFTs in minting wallet
mint <contract> --to=0xCustom      # consolidate to non-default address
```

## Internal flow

1. **Decrypt secrets**: `gpg --passphrase-file ~/.hermes/.backup-key --decrypt ~/.hermes/wallets/agent-secrets/airdrop-wallets.txt.gpg` → in-memory only, never written to disk.

2. **Chain detect** (auto): probes contract on Ethereum / Base / Arbitrum / Optimism via `eth_getCode`, picks first chain with code.

3. **Parallel preflight per wallet**:
   - Balance + EOA check (no 7702 delegate)
   - Function probe: tries `mint(uint256)`, `publicMint(uint256)`, `claim(uint256)`, `mint()` via `estimateGas`
   - Gas budget: `maxFeePerGas = bal / gasLimit`; abort if `< baseFee + 0.02 gwei tip`

4. **Surface blockers**: prints "GAS NEEDED" with exact top-up amount per wallet (deficit + 20% buffer). One message, all wallets — no back-and-forth.

5. **Parallel broadcast**: all ready wallets fire txs concurrently, each using its own gas budget.

6. **Auto-consolidate**: parses Transfer events for token IDs, runs `safeTransferFrom` from each minting wallet to wallet-burn (or `--to=`). Falls back to `transferFrom` if destination has code.

## Implementation

Script: `~/.hermes/scripts/mint-executor/mint.js`
Launcher: `~/.hermes/bin/mint` (PATH'd via `~/.profile`)
Deps: `ethers@6` in `~/.hermes/scripts/mint-executor/node_modules/`

## Pitfalls observed

### Gas budget tightness
Free mints often surface "insufficient funds for intrinsic transaction cost" because RPC's `getFeeData()` returns `maxFeePerGas = baseFee*2 + tip` which exceeds tight balances. Solution baked into script: override with `maxFee = bal / gasLimit` so the wallet's full balance becomes the gas budget. Tx still mines at `effectiveGasPrice = baseFee + tip`, refunding the overage.

### Chain auto-detect false positives
`eth_getCode` returns `0x` if contract not deployed but ALSO if RPC is broken/rate-limited. If detection says "no code on any chain" but user insists contract exists, retry with `--chain=<name>` explicit, or check on Etherscan/Basescan.

### Function probe blind spots
4 candidates cover ~95% of vanilla ERC721 contracts. For exotic mint functions (signature-gated, merkle proof, mintWithReferral, etc.), use `--fn=funcName` and pass extra args via env. Probe failure ≠ contract is bad — could be paused, sold out, or already minted by that wallet.

### Already-minted wallets surface as "skip"
If `hasMintedPublic(addr)` is true (or however the contract enforces 1-per-wallet), `estimateGas` reverts and the wallet is skipped. This is correct behavior, not a bug. The summary will show "0/N successful" but with skip reason "no mint function passed estimateGas".

### Consolidate failures don't unwind mint
If a token mints successfully but the consolidate transferFrom fails (gas spike, RPC drop), the token stays in the agent wallet. Re-run consolidate manually:
```bash
node -e "
const {HDNodeWallet, JsonRpcProvider, Contract} = require('ethers');
// derive wallet from mnemonic, call safeTransferFrom(from, to, tokenId)
"
```
Or just leave it — agent wallet is fine to hold tokens long-term.

### EIP-7702 delegate detection
If wallet `code != 0x`, script skips it as risky. This catches both 7702 delegated EOAs AND smart contract wallets. If you intentionally want to mint from a 7702-delegated wallet (e.g. Pectra-active chain with safe receiver implementation), patch the `eoa` check or use `--force` (not yet implemented).

## Verification: paste real output

After mint, the script prints actual tx hashes from `tx.wait()` receipts. NEVER fabricate tx hashes for the user. The summary block at end of stdout has explorer URLs — quote those verbatim.

If a tx reverted post-broadcast (status=0), the script prints the receipt status. Don't celebrate without checking the status field.

## Audit before running paid mints

Before running this on a paid mint (mintPrice > 0), MUST run preflight from `evm-mint-preflight` skill:
1. Sourcify check for verified source
2. Read `mint()` function source for footguns (selfdestruct, owner-drain, infinite supply, etc.)
3. Confirm mintPrice on-chain matches advertised price

Free mints (mintPrice = 0) are auto-OK per FREDY_OPS rule 3 if EOA + free + low gas. Anything paid: surface preflight summary + ask user before broadcast.

## Tracker hook

After a mint run, append to `~/.hermes/notes/fredy-garapan.md`:
```
## <Project> Mint — <date>
- Source: <CUPANG msg #/manual>
- Contract: <0x...> on <chain>
- mintPrice: <wei>  estimated cost: <ETH>
- Wallets used: <labels>
- Outcome: N/M minted
  - <wallet>: token <id>, TX <hash>
- Consolidated to: <wallet-burn or --to>
- Status: DONE / PARTIAL / FAILED
```

## Recovery: lost agent wallet secrets

If `airdrop-wallets.txt.gpg` is missing or corrupt, recover from session logs (one-time, agent-only):
```python
# See wallet-manager skill, "Quick recovery snippet" section
# Filter session JSON tokens by BIP39 wordlist → 12/24-word valid sequences → derive m/44'/60'/0'/0/0 → match address
```
Then re-encrypt to the secret store. Bug: the original `wallet-manager` flow leaked mnemonics to session JSON despite `secret_stored: false`. Mitigation documented in `wallet-manager` skill.
