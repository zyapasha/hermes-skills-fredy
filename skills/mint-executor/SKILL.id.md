---
name: mint-executor
description: Mint NFT one-shot di seluruh agent wallet secara paralel. Auto-detect chain, probe fungsi, gas budget, broadcast, dan konsolidasi ke wallet-burn. Pakai saat user bilang "mint <contract>" atau forward garapan free/low-cost mint dan butuh eksekusi multi-wallet cepat.
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [crypto, nft, mint, evm, fcfs, garapan]
    related_skills: [wallet-manager, evm-mint-preflight, eip7702-erc721-mint-check]
---

# mint-executor

🌐 [English](SKILL.md) · **Bahasa Indonesia**

## Kapan dipakai

User mau mint NFT/token di beberapa agent wallet sekaligus, cepat. Trigger:
- "mint 0xabc..."
- Garapan ping dengan address contract + free/low gas
- Apapun yang butuh kecepatan (FCFS) dan contract udah audited atau gampang diverifikasi

## Quick start

```bash
mint <contract>                    # mint paralel semua agent wallet, auto-konsolidasi ke wallet-burn
mint <contract> --dry              # preflight only, gak broadcast
mint <contract> --qty=2            # mint 2 per wallet
mint <contract> --chain=base       # skip chain detection
mint <contract> --fn=mint          # force fungsi (skip auto-probe)
mint <contract> --wallets=01,02    # filter wallet by suffix
mint <contract> --no-consolidate   # tinggalkan NFT di wallet minting
mint <contract> --to=0xCustom      # konsolidasi ke address non-default
```

## Flow internal

1. **Decrypt secrets**: `gpg --passphrase-file ~/.hermes/.backup-key --decrypt ~/.hermes/wallets/agent-secrets/airdrop-wallets.txt.gpg` → cuma di memory, gak pernah di-write ke disk.

2. **Chain detect** (auto): probe contract di Ethereum / Base / Arbitrum / Optimism via `eth_getCode`, ambil chain pertama yang ada code-nya.

3. **Preflight paralel per wallet**:
   - Cek saldo + EOA (no 7702 delegate)
   - Probe fungsi: coba `mint(uint256)`, `publicMint(uint256)`, `claim(uint256)`, `mint()` via `estimateGas`
   - Gas budget: `maxFeePerGas = bal / gasLimit`; abort kalau `< baseFee + 0.02 gwei tip`

4. **Surface blocker**: print "GAS NEEDED" dengan amount top-up tepat per wallet (deficit + 20% buffer). Satu pesan, semua wallet — gak pingpong.

5. **Broadcast paralel**: semua wallet siap fire tx bareng, masing-masing pake gas budget sendiri.

6. **Auto-konsolidasi**: parse Transfer event buat token ID, run `safeTransferFrom` dari tiap wallet minting ke wallet-burn (atau `--to=`). Fallback ke `transferFrom` kalau destination ada code.

## Implementasi

Script: `~/.hermes/scripts/mint-executor/mint.js`
Launcher: `~/.hermes/bin/mint` (PATH-nya via `~/.profile`)
Deps: `ethers@6` di `~/.hermes/scripts/mint-executor/node_modules/`

## Pitfall yang ke-observe

### Gas budget tipis
Free mint sering surface "insufficient funds for intrinsic transaction cost" karena `getFeeData()` RPC return `maxFeePerGas = baseFee*2 + tip` yang exceed saldo tipis. Solusi udah di-bake ke script: override dengan `maxFee = bal / gasLimit` jadi seluruh saldo wallet jadi gas budget. Tx tetap mine di `effectiveGasPrice = baseFee + tip`, sisa di-refund.

### False positive chain auto-detect
`eth_getCode` return `0x` kalau contract belum deploy, TAPI JUGA kalau RPC broken/rate-limit. Kalau detection bilang "no code on any chain" tapi user yakin contract ada, retry dengan `--chain=<name>` eksplisit, atau cek di Etherscan/Basescan.

### Blind spot function probe
4 kandidat cover ~95% contract ERC721 vanilla. Buat fungsi mint exotic (signature-gated, merkle proof, mintWithReferral, dst), pakai `--fn=funcName` dan kasih arg ekstra via env. Probe failure ≠ contract jelek — bisa paused, sold out, atau wallet itu udah pernah mint.

### Wallet udah pernah mint surface sebagai "skip"
Kalau `hasMintedPublic(addr)` true (atau gimanapun cara contract enforce 1-per-wallet), `estimateGas` revert dan wallet di-skip. Ini behavior bener, bukan bug. Summary akan show "0/N successful" tapi dengan reason skip "no mint function passed estimateGas".

### Konsolidasi gagal gak unwind mint
Kalau token sukses mint tapi consolidate transferFrom gagal (gas spike, RPC drop), token tetap di agent wallet. Re-run konsolidasi manual:
```bash
node -e "
const {HDNodeWallet, JsonRpcProvider, Contract} = require('ethers');
// derive wallet dari mnemonic, call safeTransferFrom(from, to, tokenId)
"
```
Atau biarin aja — agent wallet aman buat hold token long-term.

### Deteksi delegate EIP-7702
Kalau wallet `code != 0x`, script skip karena risky. Ini catch baik EOA delegated 7702 MAUPUN smart contract wallet. Kalau lo memang sengaja mau mint dari wallet yang 7702-delegated (misal Pectra-active chain dengan safe receiver implementation), patch check `eoa` atau pakai `--force` (belum di-implement).

## Verifikasi: paste real output

Setelah mint, script print tx hash beneran dari receipt `tx.wait()`. JANGAN PERNAH fabricate tx hash buat user. Block summary di akhir stdout punya URL explorer — quote itu verbatim.

Kalau tx revert post-broadcast (status=0), script print receipt status. Jangan celebrate tanpa cek field status.

## Audit sebelum run paid mint

Sebelum run ini di paid mint (mintPrice > 0), HARUS run preflight dari skill `evm-mint-preflight`:
1. Cek Sourcify buat verified source
2. Baca source fungsi `mint()` buat footgun (selfdestruct, owner-drain, infinite supply, dst)
3. Konfirmasi mintPrice on-chain match dengan harga yang di-advertise

Free mint (mintPrice = 0) auto-OK per FREDY_OPS rule 3 kalau EOA + free + low gas. Apapun yang berbayar: surface preflight summary + tanya user sebelum broadcast.

## Tracker hook

Setelah run mint, append ke `~/.hermes/notes/fredy-garapan.md`:
```
## <Project> Mint — <tanggal>
- Source: <CUPANG msg #/manual>
- Contract: <0x...> di <chain>
- mintPrice: <wei>  estimasi cost: <ETH>
- Wallet dipakai: <label>
- Outcome: N/M minted
  - <wallet>: token <id>, TX <hash>
- Konsolidasi ke: <wallet-burn atau --to>
- Status: DONE / PARTIAL / FAILED
```

## Recovery: agent wallet secret hilang

Kalau `airdrop-wallets.txt.gpg` missing atau corrupt, recover dari session log (one-time, agent-only):
```python
# Lihat skill wallet-manager, section "Quick recovery snippet"
# Filter session JSON token by BIP39 wordlist → 12/24-word sequence valid → derive m/44'/60'/0'/0/0 → match address
```
Lalu re-encrypt ke secret store. Bug: flow `wallet-manager` original leak mnemonic ke session JSON walaupun `secret_stored: false`. Mitigation di-dokumentasi di skill `wallet-manager`.
