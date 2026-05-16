---
name: eip7702-erc721-mint-check
description: Before minting an ERC721 to an EOA on a Pectra-active chain (Ethereum mainnet post-May-2025), check eth_getCode for EIP-7702 delegation. Wallets delegated to smart-account contracts that don't implement onERC721Received correctly will revert any _safeMint call with ERC721InvalidReceiver. Diagnose by code prefix 0xef0100, fix with type-4 self-tx that authorizes delegate=0x0.
---

# EIP-7702 + ERC721 _safeMint compatibility check

🌐 **English** · [Bahasa Indonesia](SKILL.id.md)

## When to use this skill

Run this check BEFORE any NFT mint where:
- The contract uses OpenZeppelin `_safeMint` (it calls `onERC721Received` on the receiver)
- The receiver is an "EOA" you control
- The chain has Pectra/EIP-7702 active (Ethereum mainnet since May 2025, plus most L2s that follow)

Also use when diagnosing a mint that reverts with selector `0x64a0ae92` (ERC721InvalidReceiver).

## The bug

EIP-7702 lets EOAs install code via type-4 transactions. The code lives at the EOA's address with prefix `0xef0100<delegate_address>`. When ERC721 `_safeMint` calls back via `onERC721Received(...)`, the call goes to the EOA's address — which now executes the delegate's code. If the delegate doesn't implement that selector (`0x150b7a02`) or returns the wrong magic value, `_safeMint` reverts with `ERC721InvalidReceiver(receiver)`.

This affects wallets that have ever connected to:
- Coinbase Smart Wallet (auto-installs delegate)
- MetaMask Smart Account toggle
- Ambire / Argent / other AA wallets that use 7702 instead of 4337
- Any dApp that prompts "upgrade your wallet" with a one-time signature

The wallet still receives plain ETH transfers fine (those don't call `onERC721Received`), so users don't notice until they try to receive an NFT via `_safeMint`.

## Detection

```bash
WALLET="0x..."
RPC="https://ethereum-rpc.publicnode.com"
curl -s "$RPC" -X POST -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$WALLET\",\"latest\"],\"id\":1}"
```

Interpret `result`:
- `"0x"` → pure EOA, safe to receive `_safeMint`
- `"0xef0100<40 hex chars>"` → EIP-7702 delegated. Likely will revert. Check delegate address before proceeding.
- Any other non-empty code → contract address (use ERC1155/ERC721 receiver-aware tooling)

If delegated, decode the delegate target:
```python
code = "0xef01001d370cfced3c7f9101f5dca5ee626447276d20be"
delegate = "0x" + code[8:]  # strip 0xef0100 prefix
```

You can verify the delegate accepts ERC721 with a static call:
```bash
# Build calldata: onERC721Received(operator, from, tokenId, bytes)
# selector 0x150b7a02 + 4 args (last is bytes offset+length)
DATA="0x150b7a02$(printf '%064s' '0' | tr ' ' '0')..."  # 32 bytes per arg
curl -s "$RPC" -X POST -H "content-type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_call\",\"params\":[{\"to\":\"$WALLET\",\"data\":\"$DATA\"},\"latest\"],\"id\":1}"
```

If the static call returns `0x150b7a02000...` (selector echoed = ERC721_RECEIVED magic), the delegate handles it. If it reverts or returns something else, it doesn't.

## Fix: revoke the delegation

Sign a type-4 tx with `authorizationList = [{delegate: 0x0, nonce: tx_nonce+1, chainId}]` from the wallet itself. The tx body can be a no-op self-call (to: self, value: 0, data: 0x). When `tx.from == authorizer`, the EIP-7702 spec requires `auth.nonce == tx.nonce + 1` because the tx bumps the sender nonce before the auth list executes.

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
# Build tx with type=4 and authorization_list=[auth]
```

Cost: ~36-50k gas. At 0.2 gwei mainnet base fee = ~0.000010 ETH.

## Verification after revoke

Re-run `eth_getCode`. Expect `"0x"`. If still `0xef0100...`, revocation failed — most likely the auth nonce was wrong. The wallet is now ready to receive `_safeMint`.

## Pitfalls

1. **Do not reconnect** to the same smart-wallet UI that installed the delegation — it'll re-prompt and re-delegate. Use the wallet from a different interface (Rabby, raw signer, etc.) for the NFT receive.

2. **PriceWei mismatch is NOT the same bug.** If you see revert selector `0xf7760f25` (`WrongPrice()`) it's a value-vs-MINT_PRICE mismatch in the calldata. Different problem. Don't be misled by your own trace if you mistype the value when re-running `debug_traceCall` (I did this once and chased the wrong selector for ten minutes).

3. **`debug_traceTransaction` (real tx) vs `debug_traceCall` (simulated)** — always trace the real on-chain tx hash for revert reasons. `debug_traceCall` results depend on what you pass in and can mislead. Use `tracer: "callTracer"` config arg (3rd param) — many RPCs reject 2-arg form.

4. **Backend single-use mint codes** can compound this. If the mint API issues a one-time code that's marked consumed after you call its `/sign` endpoint, a revert means you've burned both gas AND the mint code. Always run `eth_getCode` BEFORE the hit phase, not after.

5. **Public RPCs may not support type-4 txs.** publicnode.com and drpc.org work as of late 2025. Alchemy/Infura definitely. Avoid llamarpc for type-4 broadcasts.

## Related selectors (for fast revert decoding)

```
0x64a0ae92  ERC721InvalidReceiver(address)       <-- this skill's target bug
0xf7760f25  WrongPrice()                         <-- mint price mismatch
0x8c4841e4  MintCodeAlreadyUsed()
0x8baa579f  InvalidSignature()
```

Decode any unknown selector with:
```python
from eth_utils import keccak
print('0x' + keccak(text='SomeError(uint256)')[:4].hex())
```
