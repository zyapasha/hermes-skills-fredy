# hermes-skills-fredy

🌐 [English](README.md) · **Bahasa Indonesia**

> Koleksi skill [Hermes Agent](https://hermes-agent.nousresearch.com) yang di-extract dari penggunaan production FREDY, agen Web3 + dev-ops otonom.

Skill-skill ini encode pengalaman procedural dari menjalankan agen yang mint NFT, monitor Telegram buat alpha, dan eksekusi transaksi on-chain di production. Tiap skill adalah satu file `SKILL.md` dengan YAML frontmatter, siap di-drop ke folder `~/.hermes/skills/` lo.

## Untuk pemula: ini buat apa sih?

[Hermes Agent](https://hermes-agent.nousresearch.com) adalah framework agen otonom open-source. Lo konfigurasi, kasih tool (terminal, browser, web search, dst), konek ke platform chat (Telegram, Discord, Matrix), dan dia jalan sebagai assistant long-running.

"Skill" adalah file markdown yang di-baca agen saat task relevan muncul. Anggep kayak resep: kondisi trigger, prosedur step-by-step, pitfall yang harus dihindari. Agen otomatis load skill yang tepat berdasarkan apa yang lo minta.

Repo ini bundle 4 skill yang butuh ~2 minggu production failure buat di-refine. Drop ke setup Hermes lo, agen lo otomatis warisin lesson learned-nya.

**Siapa yang butuh?**
- Yang jalanin Hermes Agent (atau framework kompatibel) buat Web3 ops
- Builder yang penasaran gimana skill-based agent design jalan in practice
- Operator yang mau baseline yang udah teruji daripada nge-roll sendiri

**Yang lo butuhin:**
- Hermes Agent ter-install ([dokumentasi](https://hermes-agent.nousresearch.com)) — atau baca skill-nya sebagai dokumentasi aja juga oke
- Terminal Linux / macOS / WSL

## Yang ada di sini

### `skills/mint-executor/`
Pipeline mint NFT end-to-end. Auto-detect chain, probe fungsi, gas budget, broadcast paralel, konsolidasi ke cold wallet. Reference ke CLI standalone [fredy-mint-executor](https://github.com/zyapasha/fredy-mint-executor).

### `skills/evm-preflight/`
Cek preflight sebelum broadcast paid mint. Verifikasi Sourcify, baca contract, cek saldo, safety wallet EIP-7702, review red-flag source code. Encode aturan multi-step API verification yang cegah hallucinate tx hash.

Reference ke CLI standalone [fredy-evm-preflight](https://github.com/zyapasha/fredy-evm-preflight).

### `skills/eip7702-check/`
Diagnosa + fix EOA EIP-7702 yang revert `_safeMint` dengan `ERC721InvalidReceiver(0x64a0ae92)`. Detection via prefix code `0xef0100`, fix via type-4 self-tx dengan `delegate=0x0`. Termasuk snippet ethers v6 + eth-account dan quick reference revert selector.

### `skills/wallet-hardening/`
Pelajaran berharga tentang generate wallet, secret storage, dan recovery. Bug kritis yang di-dokumentasi: mnemonic yang di-generate assistant bisa bocor ke session JSON log walaupun metadata bilang `secret_stored: false`. Termasuk snippet recovery (filter BIP39 wordlist + path derivation), pattern encrypted store (GPG AES256), dan aturan anti-fabrikasi buat actionable value.

## Install

Drop folder skill ke `~/.hermes/skills/` (atau dimanapun Hermes Agent lo baca skill):

```bash
git clone https://github.com/zyapasha/hermes-skills-fredy.git
cd hermes-skills-fredy
mkdir -p ~/.hermes/skills/crypto ~/.hermes/skills/blockchain
cp -r skills/mint-executor ~/.hermes/skills/crypto/mint-executor
cp -r skills/evm-preflight ~/.hermes/skills/blockchain/evm-mint-preflight
cp -r skills/eip7702-check ~/.hermes/skills/blockchain/eip7702-erc721-mint-check
cp -r skills/wallet-hardening ~/.hermes/skills/crypto/wallet-manager
```

Restart session Hermes, skill baru muncul di `available_skills`.

## Apa itu skill Hermes?

Skill adalah file markdown dengan YAML frontmatter yang di-load agen ke context-nya saat relevan. Skill encode:

- Kapan harus trigger (field description, glob match terhadap task saat ini)
- Prosedur (step bernumber, command tepat)
- Pitfall yang ke-observe di run sebelumnya
- Step verifikasi
- Aturan anti-fabrikasi buat output yang akan di-act user

Dokumentasi Hermes Agent: [https://hermes-agent.nousresearch.com/docs/skills](https://hermes-agent.nousresearch.com/docs/skills)

## Kenapa publish

Skill-skill ini representasi ~2 minggu production use iteratif. Agen gagal dengan cara spesifik (hallucinate mint code, miss EIP-7702 delegate, leak mnemonic ke session log), tiap failure di-diagnosa, dan lesson-nya di-encode kembali ke skill. Publish supaya orang lain gak harus re-learn lesson mahal yang sama.

Kalau lo bangun agen di Hermes (atau framework apapun dengan loading skill mirip), pattern-nya transferable. Kalau lo gak pakai agen sama sekali, prosedur dan CLI-nya tetap jalan standalone — lihat sister project di bawah buat usage non-agen.

## Sister project

- **[fredy-mint-executor](https://github.com/zyapasha/fredy-mint-executor)** — CLI standalone buat pipeline mint
- **[fredy-evm-preflight](https://github.com/zyapasha/fredy-evm-preflight)** — CLI standalone buat preflight check
- **[fredy-wallet-watchdog](https://github.com/zyapasha/fredy-wallet-watchdog)** — script Python standalone buat balance diff watcher

## Kontribusi

PR welcome buat:

- Counterpart Solana (Metaplex Candy Machine V3, Token Extensions)
- Chain Cosmos / Move-VM
- Decoding revert selector tambahan
- Pattern integrasi hardware wallet

Buat tiap skill baru, mohon:
1. Run di production minimal seminggu sebelum submit
2. Sertakan section "Pitfalls" dengan minimal satu real failure mode yang lo observe
3. Strip data personal (address, path, nama, mnemonic) sebelum commit

## Lisensi

MIT — lihat [LICENSE](LICENSE).

## Disclaimer

Skill ini otomasi operasi finansial. Sudah dipakai production tapi gak warranty buat setup spesifik lo. Selalu run preflight paid mint via `fredy-evm-preflight` (atau equivalent) sebelum point tool apapun ke contract yang costing gas.
