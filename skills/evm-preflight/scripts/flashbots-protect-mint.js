#!/usr/bin/env node
/**
 * Flashbots Protect mint loop — zero-gas-risk for contested free mints.
 *
 * Pattern:
 *   - Two providers: public RPC for reads, Flashbots Protect for sends.
 *   - Direct sendTransaction({data}) bypasses ethers v6 Contract.method()
 *     estimateGas-pre-flight which throws "could not coalesce error" on
 *     contested mints.
 *   - Short poll (4 blocks ~48s) per attempt, retry with same nonce after
 *     drop. Nonce stays valid because Flashbots evicts dropped tx.
 *
 * Adapt:
 *   - CONTRACT, EXPECTED_WALLET, MINT_FN_SIG, PK_PATH below
 *   - If mint fn takes args, change calldata encoding accordingly
 *   - If mint fn is payable, add `value:` to sendTransaction
 *
 * Empirical (2026-05-16 OEGP): 8 attempts, 0 mint, 0 ETH burned (all dropped
 * by Flashbots before inclusion). Compare to public-mempool fire-blind:
 * 5 attempts, 0 mint, 0.000522 ETH burned in revert gas.
 */
const { JsonRpcProvider, Wallet, Contract, formatEther, formatUnits, getAddress, Interface } = require("ethers");
const fs = require("fs");

// ===== CONFIG =====
const READ_RPC = "https://ethereum-rpc.publicnode.com";
const FLASHBOTS_RPC = "https://rpc.flashbots.net?hint=hash";
const CONTRACT = "0xCONTRACT_HERE";
const EXPECTED_WALLET = "0xWALLET_HERE";
const MINT_FN_SIG = "freePlanting()";  // adapt to actual mint fn signature
const HAS_MINTED_FN_SIG = "hasFreePlanted(address)";  // optional pre-check fn
const PK_PATH = "/tmp/burn.pk";
const MAX_ATTEMPTS = 8;
const POLL_BLOCKS = 4;
const POLL_INTERVAL_MS = 12000;
const TIP_GWEI = 5n;  // priority fee in gwei

// Standard ABI for ERC721 + the mint fn (extend if your mint fn takes args/returns)
const ABI = [
  `function ${MINT_FN_SIG} external returns (uint256)`,
  `function ${HAS_MINTED_FN_SIG} view returns (bool)`,
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];
const IFACE = new Interface(ABI);
const CALLDATA = IFACE.encodeFunctionData(MINT_FN_SIG.split("(")[0], []);

function loadPK() {
  const raw = fs.readFileSync(PK_PATH, "utf8").trim();
  // Accept formats: raw 64-hex, 0x-prefixed, or `<label>=<0xHEX>` line
  for (const line of raw.split("\n")) {
    const m = line.match(/=(0x[0-9a-fA-F]{64})\s*$/);
    if (m) return m[1];
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return "0x" + raw;
  throw new Error("cannot parse PK from " + PK_PATH);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const readP = new JsonRpcProvider(READ_RPC);
  const fbP = new JsonRpcProvider(FLASHBOTS_RPC);
  const wallet = new Wallet(loadPK(), fbP);
  const c = new Contract(CONTRACT, IFACE, readP);

  if (getAddress(wallet.address) !== getAddress(EXPECTED_WALLET)) {
    console.error(`signer mismatch: got ${wallet.address}, expected ${EXPECTED_WALLET}`);
    process.exit(1);
  }

  const balStart = await readP.getBalance(wallet.address);
  console.log(`signer:    ${wallet.address}`);
  console.log(`saldo:     ${formatEther(balStart)} ETH`);
  console.log(`broker:    Flashbots Protect (revert-protected)`);
  console.log(`mode:      direct calldata, ${MAX_ATTEMPTS} attempts × ${POLL_BLOCKS} blocks/attempt\n`);

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    // Pre-check: skip if already minted (success in earlier attempt)
    try {
      const hasMinted = await c[HAS_MINTED_FN_SIG.split("(")[0]](wallet.address);
      if (hasMinted) { console.log(`✓ already minted — exit`); return; }
    } catch (e) { /* fn might not exist on this contract; ignore */ }

    const [latest, bal, nonce] = await Promise.all([
      readP.getBlock("latest"),
      readP.getBalance(wallet.address),
      readP.getTransactionCount(wallet.address, "latest"),
    ]);

    const baseFee = latest.baseFeePerGas;
    const gasLimit = 250000n;
    const budgetMax = (bal * 90n) / 100n / gasLimit;  // 90% of balance as gas ceiling
    const tip = TIP_GWEI * 1000000000n;
    const maxFee = budgetMax > baseFee + tip ? budgetMax : baseFee + tip;

    console.log(`[a${i}] block ${latest.number}  baseFee ${formatUnits(baseFee,"gwei").slice(0,4)}g  maxFee ${formatUnits(maxFee,"gwei").slice(0,5)}g  tip ${TIP_GWEI}g  nonce ${nonce}`);

    let txHash;
    try {
      // Direct sendTransaction — bypass ethers Contract.method() estimateGas
      const tx = await wallet.sendTransaction({
        to: CONTRACT,
        data: CALLDATA,
        gasLimit,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: tip,
        nonce,
      });
      txHash = tx.hash;
      console.log(`     submitted: ${txHash}`);
    } catch (e) {
      console.log(`     submit fail: ${(e.shortMessage || e.message || "").slice(0, 150)}`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Poll for inclusion
    let resolved = false;
    for (let p = 0; p < POLL_BLOCKS; p++) {
      await sleep(POLL_INTERVAL_MS);
      const rcpt = await readP.getTransactionReceipt(txHash).catch(() => null);
      if (rcpt) {
        if (rcpt.status === 1) {
          const tokenIds = [];
          for (const log of rcpt.logs) {
            try {
              const lp = IFACE.parseLog(log);
              if (lp?.name === "Transfer") tokenIds.push(lp.args.tokenId.toString());
            } catch {}
          }
          console.log(`\n✓ MINTED block ${rcpt.blockNumber}  tokens [${tokenIds.join(",")}]  cost ${formatEther(rcpt.gasUsed * rcpt.gasPrice)} ETH`);
          console.log(`  https://etherscan.io/tx/${txHash}`);
          const balEnd = await readP.getBalance(wallet.address);
          console.log(`  saldo: ${formatEther(balEnd)} ETH (${formatEther(balStart - balEnd)} spent)`);
          return;
        } else {
          console.log(`     ⚠ landed but reverted block ${rcpt.blockNumber} (rare under FB)`);
        }
        resolved = true;
        break;
      }
      process.stdout.write(`\r     poll ${(p+1)*12}s...    `);
    }
    if (!resolved) {
      console.log(`\n     not landed in ${POLL_BLOCKS} blocks (Flashbots dropped — 0 gas)`);
      // Same nonce is reusable: Flashbots evicted the prior tx, mempool clean
    }
  }

  const balEnd = await readP.getBalance(wallet.address);
  console.log(`\nFINAL: ${MAX_ATTEMPTS} attempts exhausted`);
  console.log(`saldo akhir: ${formatEther(balEnd)} ETH (${formatEther(balStart - balEnd)} spent)`);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
