---
name: eip7702-erc721-mint-check
description: Sebelum mint ERC721 ke EOA di chain Pectra-active (Ethereum mainnet post-May-2025), cek eth_getCode buat delegasi EIP-7702. Wallet yang ke-delegate ke contract smart-account yang gak implement onERC721Received bener akan revert call _safeMint apapun dengan ERC721InvalidReceiver. Diagnosa via prefix code 0xef0100, fix dengan type-4 self-tx yang authorize delegate=0x0.
---

# EIP-7702 + ERC721 _safeMint compatibility check

🌐 [English](SKILL.md) · **Bahasa Indonesia**

## Kapan dipakai skill ini

Run check ini SEBELUM mint NFT apapun dimana:
- Contract pakai OpenZeppelin `_safeMint` (memanggil `onERC721Received` di receiver)
- Receiver-nya "EOA" yang lo control
- Chain udah Pectra/EIP-7702 active (Ethereum mainnet sejak Mei 2025, plus mayoritas L2)

Juga pakai saat diagnosa mint yang revert dengan selector `0x64a0ae92` (ERC721InvalidReceiver).

## Bug-nya

EIP-7702 ngebolehin EOA install code via type-4 transaction. Code-nya tinggal di address EOA dengan prefix `0xef0100<delegate_address>`. Saat ERC721 `_safeMint` callback via `onERC721Received(...)`, call masuk ke address EOA — yang sekarang execute code delegate. Kalau delegate gak implement selector itu (`0x150b7a02`) atau return magic value salah, `_safeMint` revert dengan `ERC721InvalidReceiver(receiver)`.

Ini affect wallet yang pernah konek ke:
- Coinbase Smart Wallet (auto-install delegate)
- Toggle MetaMask Smart Account
- Ambire / Argent / wallet AA lain yang pakai 7702 daripada 4337
- dApp apapun yang prompt "upgrade your wallet" dengan one-time signature

Wallet tetap bisa terima transfer ETH biasa (gak panggil `onERC721Received`), jadi user gak nyadar sampe coba terima NFT via `_safeMint`.

## Detection

```bash
WALLET="0x..."
RPC="https://ethereum-rpc.publicnode.com"
curl -s "$RPC" -X POST -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$WALLET\",\"latest\"],\"id\":1}"
```

Interpretasi `result`:
- `"0x"` → EOA murni, aman terima `_safeMint`
- `"0xef0100<40 hex chars>"` → ke-delegate EIP-7702. Kemungkinan akan revert. Cek address delegate sebelum lanjut.
- Code non-empty lain → contract address (pakai tooling receiver-aware ERC1155/ERC721)

Kalau ke-delegate, decode target delegate-nya:
```python
code = "0xef01001d370cfced3c7f9101f5dca5ee626447276d20be"
delegate = "0x" + code[8:]  # strip prefix 0xef0100
```

Lo bisa verify delegate accept ERC721 dengan static call:
```bash
# Build calldata: onERC721Received(operator, from, tokenId, bytes)
# selector 0x150b7a02 + 4 args (last is bytes offset+length)
DATA="0x150b7a02$(printf '%064s' '0' | tr ' ' '0')..."  # 32 byte per arg
curl -s "$RPC" -X POST -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$WALLET\",\"data\":\"$DATA\"},\"latest\"],\"id\":1}"
```

Kalau static call return `0x150b7a02000...` (selector di-echo = magic ERC721_RECEIVED), delegate handle. Kalau revert atau return lain, dia gak handle.

## Fix: revoke delegasi

Sign type-4 tx dengan `authorizationList = [{delegate: 0x0, nonce: tx_nonce+1, chainId}]` dari wallet sendiri. Body tx bisa self-call no-op (to: self, value: 0, data: 0x). Saat `tx.from == authorizer`, spec EIP-7702 require `auth.nonce == tx.nonce + 1` karena tx bump nonce sender sebelum auth list execute.

Ethers v6 (>=6.16):

```javascript
const auth = await wallet.authorize({
  address: "0x0000000000000000000000000000000000000000",
  nonce: nonce + 1,
  chainId: Number(chainId),
});

const tx = {
  type: 4,
  chainId: Number(chainId),
  nonce: nonce,
  to: wallet.address,        // self-call, no-op
  value: 0n,
  data: "0x",
  gasLimit: 100000n,
  maxFeePerGas: feeData.maxFeePerGas,
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  authorizationList: [auth],
};

const signed = await wallet.signTransaction(tx);
const sent = await provider.broadcastTransaction(signed);
const rcpt = await sent.wait();
```

eth_account (Python, >=0.13):

```python
from eth_account import Account
auth = Account.sign_authorization({
    "chainId": 1,
    "address": "0x0000000000000000000000000000000000000000",
    "nonce": tx_nonce + 1,
}, private_key)
# Build tx dengan type=4 dan authorization_list=[auth]
```

Cost: ~36-50k gas. Di base fee 0.2 gwei mainnet = ~0.000010 ETH.

## Verifikasi setelah revoke

Re-run `eth_getCode`. Expect `"0x"`. Kalau masih `0xef0100...`, revocation gagal — kemungkinan besar nonce auth salah. Wallet siap terima `_safeMint`.

## Pitfall

1. **Jangan reconnect** ke UI smart-wallet yang sama yang install delegation — bakal re-prompt dan re-delegate. Pakai wallet dari interface beda (Rabby, raw signer, dst) buat receive NFT.

2. **Mismatch PriceWei BUKAN bug yang sama.** Kalau lo lihat revert selector `0xf7760f25` (`WrongPrice()`) itu mismatch value-vs-MINT_PRICE di calldata. Problem beda. Jangan tertipu trace lo sendiri kalau salah type value pas re-run `debug_traceCall` (gw pernah ngalamin, ngejar selector salah selama 10 menit).

3. **`debug_traceTransaction` (tx beneran) vs `debug_traceCall` (simulasi)** — selalu trace tx hash on-chain beneran buat reason revert. Hasil `debug_traceCall` tergantung apa yang lo pass dan bisa misleading. Pakai config arg `tracer: "callTracer"` (param ke-3) — banyak RPC reject form 2-arg.

4. **Backend single-use mint code** bisa compound ini. Kalau mint API issue one-time code yang ke-mark consumed setelah lo call endpoint `/sign`-nya, revert berarti lo udah ngebakar gas DAN mint code. Selalu run `eth_getCode` SEBELUM phase hit, bukan sesudah.

5. **RPC publik mungkin gak support tx type-4.** publicnode.com dan drpc.org jalan per akhir 2025. Alchemy/Infura pasti jalan. Hindari llamarpc buat broadcast type-4.

## Related selector (buat fast revert decoding)

```
0x64a0ae92  ERC721InvalidReceiver(address)       <-- bug target skill ini
0xf7760f25  WrongPrice()                         <-- mismatch mint price
0x8c4841e4  MintCodeAlreadyUsed()
0x8baa579f  InvalidSignature()
```

Decode selector unknown:
```python
from eth_utils import keccak
print('0x' + keccak(text='SomeError(uint256)')[:4].hex())
```
