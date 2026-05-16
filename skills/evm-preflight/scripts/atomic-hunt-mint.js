/**
 * Atomic hunt + sign + mint pattern (v2 — latency-optimized).
 *
 * Use when a backend issues mintCodes via a hunt API (timestamp/email/raffle
 * lookup) and a SEPARATE single-use sign endpoint, e.g. CPUNKS:
 *   POST /api/find-mint-code  -> { mintCode }
 *   POST /api/sign-mint-code  -> { signature, priceWei }   (single-use!)
 *
 * If you separate hunt from broadcast (e.g. dry-run that calls /sign, then
 * a second run for broadcast), the second /sign call will fail with
 * `mint_code_not_found`. So keep the whole flow in ONE process: hunt loop,
 * on hit immediately call /sign, then build+broadcast the tx, then exit.
 *
 * v2 inner-loop optimizations vs naive baseline:
 *   1. HTTPS keep-alive agent       — saves ~150ms TLS handshake per request
 *   2. Parallel pre-warm before fire — balance + network + schedule TLS warmup
 *   3. Schedule poll 500ms (not 3s)  — detect activeBatch transition 6x faster
 *   4. Drop inter-attempt soft sleep — API rate-limit is the natural pacer
 *   5. Respect retryInMs exactly     — no +500ms padding on find-mint-code
 *
 * Required env:
 *   RPC_URL       — mainnet RPC (Alchemy/Infura/publicnode/drpc)
 *   PRIVATE_KEY   — hex (0x-prefixed, 64 hex chars)
 *
 * Configure for your project (these defaults are CPUNKS-specific):
 *   CONTRACT      — target NFT contract
 *   API_HOST      — backend host (no scheme)
 *   FIND_PATH     — hunt endpoint
 *   SIGN_PATH     — sign endpoint
 *
 * Logging note: Hermes-background captures stdout reliably only when there's
 * a newline. Use console.log, not process.stdout.write("...\r").
 */
require("dotenv").config();
const https = require("https");
const { ethers } = require("ethers");

// --- CONFIG (tweak per project) -----------------------------------------
const CONTRACT = process.env.CONTRACT || "0x9E464d954E07abeD84081F399feE729FF99f8f93";
const ABI = [
  "function mint(bytes32 mintCode, bytes signature) payable",
  "event Minted(address indexed minter, uint256 indexed tokenId, bytes32 indexed mintCodeHash)",
];
const API_HOST = process.env.API_HOST || "unixpunks.xyz";
const FIND_PATH = process.env.FIND_PATH || "/api/find-mint-code";
const SIGN_PATH = process.env.SIGN_PATH || "/api/sign-mint-code";
const SCHEDULE_PATH = process.env.SCHEDULE_PATH || "/api/schedule";
// --------------------------------------------------------------------------

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY) { console.error("RPC_URL and PRIVATE_KEY required"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(CONTRACT, ABI, wallet);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Optimization #1: HTTP keep-alive — reuse TLS connection across all API calls
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
});

function apiPost(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST, path, method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(data),
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      },
      timeout: 8000,
      agent: keepAliveAgent,
    }, (res) => {
      let b = ""; res.on("data", (c) => b += c);
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ ok: false, error: "parse_error", raw: b }); } });
    });
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: "network_error", message: e.message }));
    req.write(data); req.end();
  });
}

function apiGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: API_HOST, path, method: "GET",
      timeout: 8000,
      agent: keepAliveAgent,
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    }, (res) => {
      let b = ""; res.on("data", (c) => b += c);
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function getSignature(mintCode) {
  while (true) {
    const res = await apiPost(SIGN_PATH, { mintCode, wallet: wallet.address });
    if (res.ok) return { signature: res.signature, priceWei: res.priceWei };
    if (res.error === "rate_limit" || res.error === "rate_limit_wallet") {
      // /sign endpoint window is tighter; +500ms padding is justified here
      const waitMs = (res.retryInMs || 5000) + 500;
      console.log(`  /sign rate-limited, waiting ${Math.ceil(waitMs/1000)}s`);
      await sleep(waitMs); continue;
    }
    throw new Error(`sign failed: ${res.error || JSON.stringify(res)}`);
  }
}

async function sendMintTx(mintCode, signature, priceWei) {
  console.log("  Sending mint tx...");
  const tx = await contract.mint(mintCode, signature, { value: BigInt(priceWei) });
  console.log("  TX hash:", tx.hash);
  console.log("  explorer:", `https://etherscan.io/tx/${tx.hash}`);
  console.log("  Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log("  Confirmed in block:", receipt.blockNumber, "status:", receipt.status);
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "Minted") console.log("  Token ID:", parsed.args.tokenId.toString());
    } catch {}
  }
  return receipt;
}

async function huntAndMint() {
  console.log("Wallet:", wallet.address);

  // Optimization #2: parallel pre-warm — balance + network + TLS handshake to API
  console.log("Pre-warming connections...");
  const [balance, _network, _ping] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getNetwork(),
    apiGet(SCHEDULE_PATH),
  ]);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // Pre-flight: if wallet has 7702 code, abort (would hit ERC721InvalidReceiver)
  const code = await provider.getCode(wallet.address);
  if (code !== "0x") {
    console.error(`Wallet has code (${code.slice(0,12)}...). Possible 7702 delegation. Run revoke7702.js first.`);
    process.exit(1);
  }

  // Optimization #3: poll schedule every 500ms (not 3000ms)
  let schedule, waitCount = 0;
  while (true) {
    schedule = await apiGet(SCHEDULE_PATH);
    if (schedule && schedule.activeBatch) break;
    waitCount++;
    if (waitCount % 10 === 0) {
      console.log(`[${new Date().toLocaleTimeString()}] No active batch (waited ${waitCount * 500}ms)`);
    }
    await sleep(500);
  }
  console.log(`Batch ${schedule.activeBatch} LIVE`);

  const batch = schedule.windows.find((w) => w.batch === schedule.activeBatch);
  const { tsRangeStart, tsRangeEnd, consumedCount, timestampsCount } = batch;
  const remaining = timestampsCount - consumedCount;
  const rangeSize = tsRangeEnd - tsRangeStart + 1;
  const hitRate = remaining / rangeSize;
  console.log(`winners ${remaining}/${timestampsCount}, hit rate ${(hitRate*100).toFixed(2)}%`);

  // Bail if hit rate too low — wait for next batch instead
  if (hitRate < 0.01) {
    console.log("hit rate <1%, batch effectively dead. Exiting (relaunch for next batch).");
    return;
  }

  const allTimestamps = [];
  for (let t = tsRangeStart; t <= tsRangeEnd; t++) allTimestamps.push(t);
  shuffle(allTimestamps);

  let attempt = 0;
  for (const ts of allTimestamps) {
    attempt++;
    while (true) {
      console.log(`[${attempt}] ts=${ts}`);
      const result = await apiPost(FIND_PATH, { timestamp: ts, wallet: wallet.address });
      if (result.ok) {
        console.log(">>> HIT mintCode:", result.mintCode);
        try {
          const { signature, priceWei } = await getSignature(result.mintCode);
          console.log("  sig OK, priceWei:", priceWei);
          await sendMintTx(result.mintCode, signature, priceWei);
          console.log("\n=== MINT SUCCESSFUL ===\n");
          return;
        } catch (err) {
          console.error("  Mint failed:", err.message || err);
          console.log("  mintCode:", result.mintCode);
          break;
        }
      }
      if (result.error === "rate_limit" || result.error === "rate_limit_wallet") {
        // Optimization #5: respect retryInMs exactly, no +500ms padding here
        const waitMs = result.retryInMs || 5000;
        console.log(`  rate-limited ${Math.ceil(waitMs/1000)}s`);
        await sleep(waitMs); continue;
      }
      if (result.error === "network_error" || result.error === "timeout" || result.error === "parse_error") {
        // parse_error = backend returned non-JSON (502/HTML error page); treat as transient
        console.log(`  ${result.error}, retry 2s`); await sleep(2000); continue;
      }
      if (result.error === "no_active_batch") { console.log("Batch closed"); return; }
      if (result.error === "invalid_timestamp") console.log("  miss");
      else if (result.error === "timestamp_already_used") console.log("  claimed");
      else if (result.error === "timestamp_already_issued") console.log("  issued");
      else console.log("  ", result.error || "unknown");
      break;
    }
    // Optimization #4: NO inter-attempt sleep — API rate-limit is the natural pacer
  }
}

huntAndMint().catch((err) => { console.error("Fatal:", err.message || err); process.exit(1); });
