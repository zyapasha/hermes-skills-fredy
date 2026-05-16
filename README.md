# hermes-skills-fredy

> A collection of [Hermes Agent](https://hermes-agent.nousresearch.com) skills extracted from production use of FREDY, an autonomous Web3 + dev-ops agent.

These skills encode hard-won procedural knowledge from running an agent that mints NFTs, monitors Telegram for alpha, and executes on-chain transactions in production. Each skill is a single `SKILL.md` file with YAML frontmatter, ready to drop into your `~/.hermes/skills/` directory.

## What's included

### `skills/mint-executor/`
End-to-end NFT mint pipeline. Auto chain detect, function probe, gas budget, parallel broadcast, consolidate to cold wallet. References the standalone CLI [fredy-mint-executor](https://github.com/zyapasha/fredy-mint-executor).

### `skills/evm-preflight/`
Preflight checks before broadcasting a paid mint. Sourcify verification, contract reads, balance check, EIP-7702 wallet safety, source-code red-flag review. Encodes the multi-step API verification rule that prevents tx-hash hallucination.

References the standalone CLI [fredy-evm-preflight](https://github.com/zyapasha/fredy-evm-preflight).

### `skills/eip7702-check/`
Diagnose and fix EIP-7702 delegated EOAs that revert `_safeMint` with `ERC721InvalidReceiver(0x64a0ae92)`. Detection via `0xef0100` code prefix, fix via type-4 self-tx with `delegate=0x0`. Includes ethers v6 + eth-account snippets and revert selector quick reference.

### `skills/wallet-hardening/`
Hard-earned lessons about wallet generation, secret storage, and recovery. The critical bug it documents: assistant-generated mnemonics can leak into session JSON logs even when metadata says `secret_stored: false`. Includes recovery snippet (BIP39 wordlist filter + path derivation), encrypted store pattern (GPG AES256), and an anti-fabrication rule for actionable values.

## Install

Drop the skill directories into `~/.hermes/skills/` (or wherever your Hermes Agent reads skills from):

```bash
git clone https://github.com/zyapasha/hermes-skills-fredy.git
cd hermes-skills-fredy
mkdir -p ~/.hermes/skills/crypto ~/.hermes/skills/blockchain
cp -r skills/mint-executor ~/.hermes/skills/crypto/mint-executor
cp -r skills/evm-preflight ~/.hermes/skills/blockchain/evm-mint-preflight
cp -r skills/eip7702-check ~/.hermes/skills/blockchain/eip7702-erc721-mint-check
cp -r skills/wallet-hardening ~/.hermes/skills/crypto/wallet-manager
```

Restart your Hermes session, and the new skills appear in `available_skills`.

## What is a Hermes skill?

A skill is a markdown file with YAML frontmatter that the agent loads into its context when relevant. Skills encode:

- When to trigger (description field, glob match against current task)
- The procedure (numbered steps, exact commands)
- Pitfalls observed in past runs
- Verification steps
- Anti-fabrication rules for outputs the user will act on

Hermes Agent docs: [https://hermes-agent.nousresearch.com/docs/skills](https://hermes-agent.nousresearch.com/docs/skills)

## Why publish

These skills represent ~2 weeks of iterative production use. The agent failed in specific ways (hallucinated mint codes, missed EIP-7702 delegates, leaked mnemonics to session logs), each failure was diagnosed, and the lesson was encoded back into the skill. Publishing them so others don't have to re-learn the same expensive lessons.

If you build agents on Hermes (or any framework with similar skill loading), the patterns transfer. If you don't use an agent at all, the underlying procedures and CLIs still work standalone — see the linked sister projects for non-agent usage.

## Sister projects

- **[fredy-mint-executor](https://github.com/zyapasha/fredy-mint-executor)** — standalone CLI for the mint pipeline
- **[fredy-evm-preflight](https://github.com/zyapasha/fredy-evm-preflight)** — standalone CLI for the preflight checks
- **[fredy-wallet-watchdog](https://github.com/zyapasha/fredy-wallet-watchdog)** — standalone Python script for the balance diff watcher

## Contributing

PRs welcome for:

- Solana counterparts (Metaplex Candy Machine V3, Token Extensions)
- Cosmos / Move-VM chains
- Additional revert selector decodings
- Hardware wallet integration patterns

For each new skill, please:
1. Run it in production for at least a week before submitting
2. Include a "Pitfalls" section with at least one real failure mode you observed
3. Strip personal data (addresses, paths, names, mnemonics) before commit

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

These skills automate financial operations. They've been used in production but are not warrantied for your specific setup. Always run a paid mint preflight via `fredy-evm-preflight` (or equivalent) before pointing any of these tools at a contract that costs gas.
