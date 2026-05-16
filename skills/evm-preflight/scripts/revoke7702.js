/**
 * Revoke EIP-7702 delegation on an EOA so it can receive ERC721 _safeMint again.
 *
 * Why: wallets touched by smart-account UIs (Coinbase Smart Wallet, MetaMask
 * Smart Account, Ambire, etc.) get delegated via EIP-7702 type-4 tx. Their
 * eth_getCode returns 0xef0100<delegate_addr>. If the delegate doesn't
 * implement onERC721Received(...) -> 0x150b7a02, _safeMint reverts with
 * ERC721InvalidReceiver(wallet). This script self-delegates to 0x0 to
 * clear the delegation in one type-4 tx.
 *
 * Tested 2026-05-15 mainnet. Costs ~37k gas (≈0.000005 ETH at 0.13 gwei).
 *
 * Usage:
 *   npm install ethers@6
 *   RPC_URL=https://ethereum-rpc.publicnode.com \
 *   PRIVATE_KEY="$(cat /tmp/wallet.pk)" \
 *   BROADCAST=1 \
 *   node revoke7702.js
 *
 * Omit BROADCAST=1 for a dry-run (signs but doesn't send).
 *
 * After mining, eth_getCode(wallet, "latest") should return "0x".
 */
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://ethereum-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BROADCAST = process.env.BROADCAST === "1";

if (!PRIVATE_KEY) { console.error("PRIVATE_KEY env missing"); process.exit(1); }

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log("Wallet:", wallet.address);

  const codeBefore = await provider.getCode(wallet.address);
  console.log("Code before:", codeBefore);
  if (codeBefore === "0x") {
    console.log("Already clean EOA, no revocation needed.");
    return;
  }
  if (!codeBefore.startsWith("0xef0100")) {
    console.log("Code is not 7702 delegation prefix (0xef0100). Aborting — this script only handles 7702.");
    return;
  }

  const balance = await provider.getBalance(wallet.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const chainId = (await provider.getNetwork()).chainId;
  console.log("nonce:", nonce, "chainId:", chainId.toString());

  // EIP-7702: when sender == authorizer, the auth nonce must be tx.nonce + 1
  // (the tx itself bumps the nonce before the authorization list is processed).
  const auth = await wallet.authorize({
    address: "0x0000000000000000000000000000000000000000",
    nonce: nonce + 1,
    chainId: Number(chainId),
  });
  // PITFALL: ethers v6 returns BigInt for auth.nonce/chainId. JSON.stringify
  // throws on BigInt. Guard before logging.
  console.log("Authorization signed:", JSON.stringify({
    address: auth.address,
    nonce: typeof auth.nonce === "bigint" ? auth.nonce.toString() : auth.nonce,
    chainId: typeof auth.chainId === "bigint" ? auth.chainId.toString() : auth.chainId,
    yParity: auth.signature?.yParity ?? auth.yParity,
  }));

  const feeData = await provider.getFeeData();

  // Self-call (to: self, value 0, data 0x). The tx is a no-op; its only
  // purpose is to carry the authorizationList that clears the delegation.
  const tx = {
    type: 4,
    chainId: Number(chainId),
    nonce: nonce,
    to: wallet.address,
    value: 0n,
    data: "0x",
    gasLimit: 100000n,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
    authorizationList: [auth],
  };

  const signed = await wallet.signTransaction(tx);

  if (!BROADCAST) {
    console.log("DRY-RUN — re-run with BROADCAST=1 to send.");
    return;
  }

  console.log("Broadcasting...");
  const sent = await provider.broadcastTransaction(signed);
  console.log("txHash:", sent.hash);
  console.log("explorer:", "https://etherscan.io/tx/" + sent.hash);
  const rcpt = await sent.wait();
  console.log("status:", rcpt.status, "gasUsed:", rcpt.gasUsed.toString(),
              "effGasPrice:", ethers.formatUnits(rcpt.gasPrice, "gwei"), "gwei");

  const codeAfter = await provider.getCode(wallet.address);
  console.log("Code after:", codeAfter);
  if (codeAfter === "0x") {
    console.log("✅ Delegation revoked. Wallet is now pure EOA.");
  } else {
    console.log("⚠ Code still present — revocation may not have taken effect on this RPC's view yet.");
  }
})().catch((e) => { console.error("ERR:", e.message || e); process.exit(1); });
