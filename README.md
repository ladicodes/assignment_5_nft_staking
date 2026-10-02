# NFT Staking Core

Week 5 Metaplex NFT staking assignment, built on the instructor's Anchor starter program. Users stake Metaplex Core NFTs while retaining ownership, earn SPL reward tokens, claim without unstaking, and optionally burn a staked NFT for a one-time bonus.

## Assignment features

- **Claim rewards without unstaking:** `claim_rewards` mints pending rewards to the owner's reward-token associated token account (ATA), creating it if needed. It records the cumulative amount claimed while leaving the NFT staked and frozen.
- **Burn-to-earn:** `burn_staked_nft` thaws the staked NFT, adds a BurnDelegate authorized to the collection update-authority PDA, and invokes the Core burn instruction with that PDA. It pays unclaimed staking rewards plus **1,000 reward tokens** and decrements the collection staking count. Burning, accounting, and minting occur in one atomic transaction.
- **Collection-level staking stats:** the Collection's own Attributes plugin stores `"total_staked"`. Collection creation initializes it to `"0"`; successful stake increments it, and unstake or burn decrements it. Checked arithmetic rejects underflow and overflow; malformed, missing, or duplicate count attributes are not silently accepted.

## Staking and reward flow

1. Create a Core collection and initialize its staking configuration and six-decimal reward mint.
2. Mint a Core NFT into that collection. The NFT owner signs `stake`, which sets staking attributes, freezes the NFT, and increments `total_staked`.
3. Claim rewards whenever desired. Claims do not reset the original staking timestamp or change the freeze period.
4. After the configured minimum number of days, unstake to receive remaining rewards. Unstake resets the staking attributes, thaws and removes the FreezeDelegate, and decrements the count. The NFT can then be staked again.
5. Alternatively, burn the staked NFT to receive pending rewards and the bonus. The burn instruction does not require the unstake freeze period to have elapsed. The burned asset can no longer stake, claim, unstake, or receive another burn bonus.

Rewards preserve the starter's whole-day calculation:

```text
elapsed_days = floor((current_timestamp - staked_at) / 86,400)
total_rewards = floor(elapsed_days × rewards_bps × 10^decimals / 10,000)
pending_rewards = total_rewards - rewards_claimed
```

Amounts are in token base units. At `rewards_bps = 10,000` and six decimals, an NFT earns one reward token per complete day. This is a daily token emission formula, not a percentage of the NFT's market value.

`rewards_claimed` stores cumulative minted base units for the current staking session. A claim sets it to `total_rewards`; a repeated claim with no additional whole-day accrual mints zero. Keeping `staked_at` unchanged preserves partial-day accrual. Unstake and burn use the same pending-reward calculation, so previously claimed rewards are not paid again. Restaking resets tracking for the new session.

## Program instructions

| Instruction                              | Purpose                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `create_collection(name, uri)`           | Create a Core collection under the program's update-authority PDA, including its staking count.                  |
| `initialize(rewards_bps, freeze_period)` | Create the collection configuration and reward mint; `freeze_period` is in days.                                 |
| `mint_asset(name, uri)`                  | Create a Core NFT in the collection, owned by the signing user.                                                  |
| `stake()`                                | Mark the owner's NFT as staked, freeze it, and increment the collection count.                                   |
| `claim_rewards()`                        | Mint pending rewards without thawing or unstaking.                                                               |
| `unstake()`                              | Enforce the freeze period, pay pending rewards, clear staking state, and decrement the count.                    |
| `burn_staked_nft()`                      | Permanently burn a staked NFT through BurnDelegate, pay pending rewards plus the bonus, and decrement the count. |

## State and PDA architecture

| Account                         | Seeds or ownership                         | Role                                                                        |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Collection update-authority PDA | `["update_authority", collection_pubkey]`  | Controls the Core collection and signs authorized plugin CPIs.              |
| `Config` PDA                    | `["config", collection_pubkey]`            | Stores `rewards_bps`, `freeze_period`, and configuration/reward-mint bumps. |
| Reward mint PDA                 | `["rewards_mint", config_pubkey]`          | Six-decimal SPL mint; the `Config` PDA is its mint authority.               |
| User reward ATA                 | Standard ATA for the owner and reward mint | Receives claim, unstake, and burn rewards.                                  |
| Core asset and collection       | Owned by the Metaplex Core program         | Store NFT/collection data and their plugins.                                |

There is no separate per-NFT staking PDA. Each asset's Attributes plugin holds `staked`, `staked_at`, and `rewards_claimed`. The Collection's Attributes plugin holds `total_staked`. Owner and collection/update-authority constraints bind staking operations to the correct NFT and collection.

### Metaplex Core plugins

- **Attributes:** update-authority-managed storage for the asset's staking/reward tracking and the collection's staking count. Updates retain unrelated attributes.
- **FreezeDelegate:** added with the owner's signature and assigned to the update authority. The frozen NFT remains in the owner's wallet; claims leave this plugin unchanged. Unstake thaws it and removes the plugin so restaking can add it again.
- **BurnDelegate:** added during `burn_staked_nft` with the owner's signature and an explicit PDA address authority. The PDA then signs the Core burn CPI. Thawing occurs first because a frozen NFT cannot be burned.

A Core burn removes the asset's usable staking/plugin state; Core may retain a one-byte uninitialized tombstone. Transaction atomicity prevents a partial burn, payout, or count update from being committed.

## Technologies

Rust, Solana, Anchor and Anchor SPL 0.31.1, the Metaplex Core Rust SDK, TypeScript, the Metaplex Core JavaScript SDK and Umi, SPL Token, Mocha/Chai, and Surfpool for local integration tests and time travel. Dependency versions are recorded in `Cargo.lock` and `yarn.lock`.

## Project structure

```text
programs/anchor-core-staking/
  src/lib.rs                 Program entry points
  src/constants.rs           Day length and burn bonus
  src/error.rs               Program errors
  src/state/                 Config account
  src/instructions/          Instruction accounts and handlers
    staking.rs               Shared reward/count logic and unit tests
tests/anchor-core-staking.ts  End-to-end staking tests
migrations/deploy.ts          Starter migration hook
runbooks/                    Starter Surfpool deployment runbooks
txtx.yml                     Runbook configuration
Anchor.toml                  Anchor configuration
Cargo.toml / Cargo.lock      Rust workspace and locked dependencies
package.json / yarn.lock     JavaScript dependencies and formatting scripts
```

## Setup and build

Install Rust, the Solana CLI/SBF build tools, Anchor CLI 0.31.1, Node.js with Yarn Classic, and Surfpool. A complete nightly Rust toolchain is needed for Anchor 0.31.1 IDL generation. The verified local build used Solana 3.1.10 and integration tests used Surfpool 1.6.0.

```bash
git clone https://github.com/ladicodes/assignment_5_nft_staking.git
cd assignment_5_nft_staking
avm install 0.31.1
avm use 0.31.1
rustup toolchain install nightly --profile minimal
yarn install --frozen-lockfile
anchor build
```

Run commands from the repository root. Use a local development wallet at the standard wallet location configured in `Anchor.toml`; create one with `solana-keygen new` if needed. Wallet/keypair contents are not part of the repository. `anchor build` generates the program binary, IDL, and TypeScript types under the ignored `target/` directory. Building is required before typechecking or running the integration tests.

## Tests

Rust unit tests do not need a running validator:

```bash
cargo test --workspace
cargo fmt --check
yarn lint
yarn tsc --noEmit
```

The integration suite uses `surfnet_timeTravel` to advance the on-chain clock. A standard `solana-test-validator` alone cannot run these tests as written.

In one terminal, start a local Surfpool instance. The devnet datasource provides the Metaplex Core program; transactions execute locally. Startup funds the configured local wallet.

```bash
surfpool start --network devnet --no-deploy --no-tui --no-studio
```

In another terminal, load the built program at its configured address using the local Surfpool account cheatcode. This matches the successful test setup and avoids needing the instructor's original program keypair. The loader reads the address from the generated IDL and installs the ELF binary as a local executable account; it does not deploy to devnet or mainnet.

```bash
node <<'JS'
const fs = require("fs");
(async () => {
  const idl = JSON.parse(fs.readFileSync("target/idl/anchor_core_staking.json", "utf8"));
  const response = await fetch("http://127.0.0.1:8899", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "surfnet_setAccount",
      params: [idl.address, {
        lamports: 10000000000,
        owner: "BPFLoader2111111111111111111111111111111111",
        executable: true,
        data: fs.readFileSync("target/deploy/anchor_core_staking.so").toString("hex"),
      }],
    }),
  });
  const result = await response.json();
  if (result.error) throw new Error(JSON.stringify(result.error));
  console.log("Program loaded on local Surfpool:", idl.address);
})().catch((error) => { console.error(error); process.exitCode = 1; });
JS
anchor test --skip-build --skip-deploy --skip-local-validator
```

The tests use confirmed commitment and unique transaction signatures to avoid replaying an earlier successful transaction during repeated-operation checks.

### Verified results

| Check                                                                            | Obtained result                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `cargo test --workspace`                                                         | **5 passed, 0 failed**; four staking/accounting unit tests and the program-ID test. |
| Surfpool integration run                                                         | **17 passed, 0 failed**.                                                            |
| Anchor 0.31.1 build with Solana 3.1.10                                           | Successful SBF build and IDL/type generation.                                       |
| Rust formatting, Prettier checks, TypeScript checking, and Git whitespace checks | Passed.                                                                             |

Integration coverage includes collection creation, mint/config initialization, unstaked-asset rejection, staking, duplicate-stake rejection, claims that preserve the frozen state, repeated and later claims, freeze-period enforcement, unstake payout after claims, restaking, multiple staked NFTs, burn bonus/pending rewards, permanent-burn rejection checks, and collection-count changes. Unit tests also cover partial-day accrual, invalid reward tracking, arithmetic overflow, and malformed or underflowing collection counts.

## Implementation limits

Older collections without the initialized `total_staked` attribute require migration before count-changing operations; this version does not guess their existing stake count or include a migration instruction. Legacy asset attributes without `rewards_claimed` are interpreted as zero claimed rewards.

The verified build emitted Metaplex dependency stack-size diagnostics and SBF toolchain syscall warnings, plus a Borsh future-compatibility warning during IDL generation. The tested local instruction paths passed despite those diagnostics. These results describe local testing, not a public deployment or a security audit.
