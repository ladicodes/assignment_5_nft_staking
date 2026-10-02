import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorCoreStaking } from "../target/types/anchor_core_staking";
import { SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { publicKey, lamports } from "@metaplex-foundation/umi";
import {
  deserializeAssetV1,
  deserializeCollectionV1,
  Key,
  MPL_CORE_PROGRAM_ID,
} from "@metaplex-foundation/mpl-core";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const MILLISECONDS_PER_DAY = 86400000;
const REWARDS_BPS = 10000;
const FREEZE_PERIOD_IN_DAYS = 7;
const TIME_TRAVEL_IN_DAYS = 8;

describe("anchor-core-staking", () => {
  // Configure the client to use the local cluster.
  const environmentProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    environmentProvider.connection,
    environmentProvider.wallet,
    {
      ...environmentProvider.opts,
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    }
  );
  anchor.setProvider(provider);

  const program = anchor.workspace
    .anchorCoreStaking as Program<AnchorCoreStaking>;

  // Generate a keypair for the collection
  const collectionKeypair = anchor.web3.Keypair.generate();

  // Find the update authority for the collection (PDA)
  const updateAuthority = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("update_authority"), collectionKeypair.publicKey.toBuffer()],
    program.programId
  )[0];

  // Generate a keypair for the nft asset
  const nftKeypair = anchor.web3.Keypair.generate();
  const secondNftKeypair = anchor.web3.Keypair.generate();

  // Find the config account (PDA)
  const config = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config"), collectionKeypair.publicKey.toBuffer()],
    program.programId
  )[0];

  // Find the rewards mint account (PDA)
  const rewardsMint = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("rewards_mint"), config.toBuffer()],
    program.programId
  )[0];

  const userRewardsAta = getAssociatedTokenAddressSync(
    rewardsMint,
    provider.wallet.publicKey
  );
  const rewardAccounts = (asset = nftKeypair.publicKey) => ({
    owner: provider.wallet.publicKey,
    updateAuthority,
    config,
    rewardsMint,
    userRewardsAta,
    asset,
    collection: collectionKeypair.publicKey,
    mplCoreProgram: new anchor.web3.PublicKey(MPL_CORE_PROGRAM_ID),
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  });

  let transactionNonce = 0;
  function uniqueTransaction() {
    return anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: ++transactionNonce,
    });
  }

  async function rawAccount(address: anchor.web3.PublicKey) {
    const account = await provider.connection.getAccountInfo(address);
    expect(account).not.to.equal(null);
    return {
      publicKey: publicKey(address.toBase58()),
      owner: publicKey(account!.owner.toBase58()),
      executable: account!.executable,
      lamports: lamports(account!.lamports),
      data: account!.data,
    };
  }

  async function nftState(asset = nftKeypair.publicKey) {
    return deserializeAssetV1(await rawAccount(asset));
  }

  async function assertTotalStaked(count: number) {
    const collection = deserializeCollectionV1(
      await rawAccount(collectionKeypair.publicKey)
    );
    const entries = collection.attributes!.attributeList.filter(
      (a) => a.key === "total_staked"
    );
    expect(entries).to.have.length(1);
    expect(entries[0].value).to.equal(count.toString());
  }

  async function rewardBalance() {
    return (await provider.connection.getTokenAccountBalance(userRewardsAta))
      .value.amount;
  }

  async function expectFailure(action: Promise<unknown>, code?: string) {
    try {
      await action;
    } catch (error) {
      if (code) {
        expect(error).to.be.instanceOf(anchor.AnchorError);
        expect((error as anchor.AnchorError).error.errorCode.code).to.equal(
          code
        );
      }
      return;
    }
    throw new Error("Transaction unexpectedly succeeded");
  }

  async function advanceStakedDays(asset: anchor.web3.PublicKey, days: number) {
    const state = await nftState(asset);
    const stakedAt = Number(
      state.attributes!.attributeList.find((a) => a.key === "staked_at")!.value
    );
    await advanceTime({
      absoluteTimestamp: stakedAt * 1000 + days * MILLISECONDS_PER_DAY + 10000,
    });
  }

  // Helper function to advance time with Surfpool
  async function advanceTime(params: {
    absoluteEpoch?: number;
    absoluteSlot?: number;
    absoluteTimestamp?: number;
  }): Promise<void> {
    const rpcResponse = await fetch(provider.connection.rpcEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_timeTravel",
        params: [params],
      }),
    });

    const result = (await rpcResponse.json()) as { error?: any; result?: any };
    if (result.error) {
      throw new Error(`Time travel failed: ${JSON.stringify(result.error)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  it("Create a collection", async () => {
    const collectionName = "Test Collection";
    const collectionUri = "https://example.com/collection";
    const tx = await program.methods
      .createCollection(collectionName, collectionUri)
      .accountsPartial({
        payer: provider.wallet.publicKey,
        collection: collectionKeypair.publicKey,
        updateAuthority,
        systemProgram: SystemProgram.programId,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([collectionKeypair])
      .preInstructions([uniqueTransaction()])
      .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("Collection address", collectionKeypair.publicKey.toBase58());
    await assertTotalStaked(0);
  });

  it("Mint an NFT", async () => {
    const nftName = "Test NFT";
    const nftUri = "https://example.com/nft";
    const tx = await program.methods
      .mintAsset(nftName, nftUri)
      .accountsPartial({
        user: provider.wallet.publicKey,
        asset: nftKeypair.publicKey,
        collection: collectionKeypair.publicKey,
        updateAuthority,
        systemProgram: SystemProgram.programId,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([nftKeypair])
      .preInstructions([uniqueTransaction()])
      .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("NFT address", nftKeypair.publicKey.toBase58());
  });

  it("Initialize Config", async () => {
    const tx = await program.methods
      .initialize(REWARDS_BPS, FREEZE_PERIOD_IN_DAYS)
      .accountsPartial({
        admin: provider.wallet.publicKey,
        collection: collectionKeypair.publicKey,
        updateAuthority,
        config,
        rewardsMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([uniqueTransaction()])
      .rpc();
    console.log("\nYour transaction signature", tx);
    console.log("Config address", config.toBase58());
    console.log("Rewards BPS", REWARDS_BPS);
    console.log("Freeze period in days", FREEZE_PERIOD_IN_DAYS);
    console.log("Rewards mint address", rewardsMint.toBase58());
  });

  it("Reject claims and burns before the NFT has ever been staked", async () => {
    await expectFailure(
      program.methods
        .claimRewards()
        .accountsPartial(rewardAccounts())
        .preInstructions([uniqueTransaction()])
        .rpc(),
      "AssetNotStaked"
    );
    await expectFailure(
      program.methods
        .burnStakedNft()
        .accountsPartial(rewardAccounts())
        .preInstructions([uniqueTransaction()])
        .rpc(),
      "AssetNotStaked"
    );
    expect(await provider.connection.getAccountInfo(userRewardsAta)).to.equal(
      null
    );
    await assertTotalStaked(0);
  });

  it("Stake an NFT", async () => {
    const tx = await program.methods
      .stake()
      .accountsPartial({
        owner: provider.wallet.publicKey,
        updateAuthority,
        config,
        asset: nftKeypair.publicKey,
        collection: collectionKeypair.publicKey,
        systemProgram: SystemProgram.programId,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .preInstructions([uniqueTransaction()])
      .rpc();
    console.log("\nYour transaction signature", tx);
  });

  it("Reject duplicate stakes without changing the collection count", async () => {
    await assertTotalStaked(1);
    const state = await nftState();
    expect(state.freezeDelegate!.frozen).to.equal(true);
    await expectFailure(
      program.methods
        .stake()
        .accountsPartial(rewardAccounts())
        .preInstructions([uniqueTransaction()])
        .rpc(),
      "AlreadyStaked"
    );
    await assertTotalStaked(1);
  });

  it("Claim rewards while the NFT stays staked and frozen", async () => {
    await advanceStakedDays(nftKeypair.publicKey, 2);
    const before = await nftState();
    await program.methods
      .claimRewards()
      .accountsPartial(rewardAccounts())
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect(await rewardBalance()).to.equal("2000000");
    const after = await nftState();
    expect(after.owner).to.equal(
      publicKey(provider.wallet.publicKey.toBase58())
    );
    expect(after.freezeDelegate!.frozen).to.equal(true);
    expect(
      after.attributes!.attributeList.find((a) => a.key === "staked")!.value
    ).to.equal("true");
    expect(
      after.attributes!.attributeList.find((a) => a.key === "staked_at")!.value
    ).to.equal(
      before.attributes!.attributeList.find((a) => a.key === "staked_at")!.value
    );
    expect(
      after.attributes!.attributeList.find((a) => a.key === "rewards_claimed")!
        .value
    ).to.equal("2000000");
    await assertTotalStaked(1);
  });

  it("Repeated claims do not mint the same rewards again", async () => {
    await program.methods
      .claimRewards()
      .accountsPartial(rewardAccounts())
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect(await rewardBalance()).to.equal("2000000");
    expect((await nftState()).freezeDelegate!.frozen).to.equal(true);
    await assertTotalStaked(1);
  });

  it("Later claims mint only newly accumulated rewards", async () => {
    await advanceStakedDays(nftKeypair.publicKey, 3);
    await program.methods
      .claimRewards()
      .accountsPartial(rewardAccounts())
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect(await rewardBalance()).to.equal("3000000");
    await assertTotalStaked(1);
  });

  it("Try to unstake an NFT before the freeze period ends", async () => {
    // Get the user rewards ATA account
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    try {
      const tx = await program.methods
        .unstake()
        .accountsPartial({
          owner: provider.wallet.publicKey,
          updateAuthority,
          config,
          rewardsMint,
          userRewardsAta,
          asset: nftKeypair.publicKey,
          collection: collectionKeypair.publicKey,
          mplCoreProgram: MPL_CORE_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .preInstructions([uniqueTransaction()])
        .rpc();
      throw new Error(
        `Unstake should have failed before freeze period elapsed, but succeeded with tx: ${tx}`
      );
    } catch (err) {
      if (
        err instanceof anchor.AnchorError &&
        err.error.errorCode.code === "FreezePeriodNotElapsed"
      ) {
        console.log("\nUnstake failed as expected:", err.error.errorMessage);
      } else {
        throw err;
      }
    }
  });

  it("Time travel to the future", async () => {
    // Advance time in milliseconds
    await advanceStakedDays(nftKeypair.publicKey, TIME_TRAVEL_IN_DAYS);
    console.log("\nTime traveled in days", TIME_TRAVEL_IN_DAYS);
  });

  it("Unstake an NFT", async () => {
    // Get the user rewards ATA account
    const userRewardsAta = getAssociatedTokenAddressSync(
      rewardsMint,
      provider.wallet.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const tx = await program.methods
      .unstake()
      .accountsPartial({
        owner: provider.wallet.publicKey,
        updateAuthority,
        config,
        rewardsMint,
        userRewardsAta,
        asset: nftKeypair.publicKey,
        collection: collectionKeypair.publicKey,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .preInstructions([uniqueTransaction()])
      .rpc();
    console.log("\nYour transaction signature", tx);
    console.log(
      "User rewards balance",
      (await provider.connection.getTokenAccountBalance(userRewardsAta)).value
        .uiAmount
    );
    expect(await rewardBalance()).to.equal("8000000");
    const state = await nftState();
    expect(state.freezeDelegate).to.equal(undefined);
    expect(
      state.attributes!.attributeList.find((a) => a.key === "staked")!.value
    ).to.equal("false");
    await assertTotalStaked(0);
  });
  it("Reject claims and burns on an unstaked NFT", async () => {
    await expectFailure(
      program.methods
        .claimRewards()
        .accountsPartial(rewardAccounts())
        .preInstructions([uniqueTransaction()])
        .rpc(),
      "AssetNotStaked"
    );
    await expectFailure(
      program.methods
        .burnStakedNft()
        .accountsPartial(rewardAccounts())
        .preInstructions([uniqueTransaction()])
        .rpc(),
      "AssetNotStaked"
    );
    expect(await rewardBalance()).to.equal("8000000");
    await assertTotalStaked(0);
  });

  it("Restake and track multiple staked NFTs", async () => {
    await program.methods
      .stake()
      .accountsPartial(rewardAccounts())
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect((await nftState()).freezeDelegate!.frozen).to.equal(true);
    expect(
      (await nftState()).attributes!.attributeList.find(
        (a) => a.key === "rewards_claimed"
      )!.value
    ).to.equal("0");
    await assertTotalStaked(1);
    await program.methods
      .mintAsset("Second NFT", "https://example.com/second")
      .accountsPartial({
        user: provider.wallet.publicKey,
        asset: secondNftKeypair.publicKey,
        collection: collectionKeypair.publicKey,
        updateAuthority,
        systemProgram: SystemProgram.programId,
        mplCoreProgram: MPL_CORE_PROGRAM_ID,
      })
      .signers([secondNftKeypair])
      .preInstructions([uniqueTransaction()])
      .rpc();
    await program.methods
      .stake()
      .accountsPartial(rewardAccounts(secondNftKeypair.publicKey))
      .preInstructions([uniqueTransaction()])
      .rpc();
    await assertTotalStaked(2);
  });

  it("Burn-to-earn pays pending rewards plus the 1000-token bonus and burns the NFT", async () => {
    await advanceStakedDays(nftKeypair.publicKey, 2);
    await program.methods
      .claimRewards()
      .accountsPartial(rewardAccounts())
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect(await rewardBalance()).to.equal("10000000");
    await advanceStakedDays(nftKeypair.publicKey, 3);
    await program.methods
      .burnStakedNft()
      .accountsPartial(rewardAccounts())
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect(await rewardBalance()).to.equal("1011000000");
    const burned = await provider.connection.getAccountInfo(
      nftKeypair.publicKey
    );
    // Core may retain a one-byte tombstone for a burned asset.
    if (burned !== null) {
      expect(burned.data.length).to.equal(1);
      expect(burned.data[0]).to.equal(Key.Uninitialized);
    }
    await assertTotalStaked(1);
    expect(
      (await nftState(secondNftKeypair.publicKey)).freezeDelegate!.frozen
    ).to.equal(true);
  });

  it("Burned NFTs cannot claim, burn, unstake, or stake again", async () => {
    const before = await rewardBalance();
    for (const instruction of [
      program.methods.claimRewards(),
      program.methods.burnStakedNft(),
      program.methods.unstake(),
      program.methods.stake(),
    ]) {
      await expectFailure(
        instruction
          .accountsPartial(rewardAccounts())
          .preInstructions([uniqueTransaction()])
          .rpc()
      );
    }
    expect(await rewardBalance()).to.equal(before);
    await assertTotalStaked(1);
  });

  it("Unstake the remaining NFT and reject repeated unstakes", async () => {
    await advanceStakedDays(secondNftKeypair.publicKey, 8);
    await program.methods
      .unstake()
      .accountsPartial(rewardAccounts(secondNftKeypair.publicKey))
      .preInstructions([uniqueTransaction()])
      .rpc();
    expect(await rewardBalance()).to.equal("1019000000");
    await assertTotalStaked(0);
    await expectFailure(
      program.methods
        .unstake()
        .accountsPartial(rewardAccounts(secondNftKeypair.publicKey))
        .preInstructions([uniqueTransaction()])
        .rpc(),
      "AssetNotStaked"
    );
    await assertTotalStaked(0);
  });
});
