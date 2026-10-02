use super::staking::{staking_rewards, update_total_staked};
use crate::{error::ErrorCode, Config};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{mint_to_checked, Mint, MintToChecked, TokenAccount, TokenInterface},
};
use mpl_core::{
    accounts::{BaseAssetV1, BaseCollectionV1},
    fetch_plugin,
    instructions::{AddPluginV1CpiBuilder, BurnV1CpiBuilder, UpdatePluginV1CpiBuilder},
    types::{
        Attributes, BurnDelegate, FreezeDelegate, Plugin, PluginAuthority, PluginType,
        UpdateAuthority,
    },
    ID as MPL_CORE_ID,
};

#[derive(Accounts)]
pub struct BurnStakedNft<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        seeds = [b"config", collection.key().as_ref()],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        has_one = owner @ ErrorCode::InvalidOwner,
        constraint = asset.update_authority == UpdateAuthority::Collection(collection.key()) @ ErrorCode::InvalidUpdateAuthority,
    )]
    pub asset: Account<'info, BaseAssetV1>,
    #[account(
        mut,
        has_one = update_authority @ ErrorCode::InvalidUpdateAuthority
    )]
    pub collection: Account<'info, BaseCollectionV1>,
    /// CHECK: This account data is not used, we only verify the address
    #[account(
        seeds = [b"update_authority", collection.key().as_ref()],
        bump,
    )]
    pub update_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"rewards_mint", config.key().as_ref()],
        bump = config.rewards_bump,
    )]
    pub rewards_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = rewards_mint,
        associated_token::authority = owner,
    )]
    pub user_rewards_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: This is the MPL Core program
    #[account(address = Pubkey::from(MPL_CORE_ID.to_bytes()))]
    pub mpl_core_program: UncheckedAccount<'info>,
}
pub fn handler(ctx: Context<BurnStakedNft>) -> Result<()> {
    let attributes = fetch_plugin::<BaseAssetV1, Attributes>(
        &ctx.accounts.asset.to_account_info(),
        PluginType::Attributes,
    )
    .map_err(|_| ErrorCode::AssetNotStaked)?
    .1;
    let (_, _, amount) = staking_rewards(
        &attributes,
        Clock::get()?.unix_timestamp,
        ctx.accounts.config.rewards_bps,
        ctx.accounts.rewards_mint.decimals,
    )?;
    let collection_key = ctx.accounts.collection.key();
    let signer_seeds = &[
        b"update_authority",
        collection_key.as_ref(),
        &[ctx.bumps.update_authority],
    ];
    UpdatePluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.collection.to_account_info()))
        .payer(&ctx.accounts.owner.to_account_info())
        .authority(Some(&ctx.accounts.update_authority.to_account_info()))
        .system_program(&ctx.accounts.system_program.to_account_info())
        .plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: false }))
        .invoke_signed(&[signer_seeds])?;
    AddPluginV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.collection.to_account_info()))
        .payer(&ctx.accounts.owner.to_account_info())
        .authority(Some(&ctx.accounts.owner.to_account_info()))
        .system_program(&ctx.accounts.system_program.to_account_info())
        .plugin(Plugin::BurnDelegate(BurnDelegate {}))
        .init_authority(PluginAuthority::Address {
            address: ctx.accounts.update_authority.key(),
        })
        .invoke()?;
    BurnV1CpiBuilder::new(&ctx.accounts.mpl_core_program.to_account_info())
        .asset(&ctx.accounts.asset.to_account_info())
        .collection(Some(&ctx.accounts.collection.to_account_info()))
        .payer(&ctx.accounts.owner.to_account_info())
        .authority(Some(&ctx.accounts.update_authority.to_account_info()))
        .system_program(Some(&ctx.accounts.system_program.to_account_info()))
        .invoke_signed(&[signer_seeds])?;
    update_total_staked(
        &ctx.accounts.collection.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.update_authority.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.mpl_core_program.to_account_info(),
        signer_seeds,
        false,
    )?;
    let bonus = crate::BURN_REWARD_TOKENS
        .checked_mul(
            10u64
                .checked_pow(ctx.accounts.rewards_mint.decimals as u32)
                .ok_or(ErrorCode::InvalidRewardsBps)?,
        )
        .ok_or(ErrorCode::InvalidRewardsBps)?;
    let amount = amount
        .checked_add(bonus)
        .ok_or(ErrorCode::InvalidRewardsBps)?;
    let config_seeds = &[
        b"config",
        collection_key.as_ref(),
        &[ctx.accounts.config.bump],
    ];
    mint_to_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintToChecked {
                mint: ctx.accounts.rewards_mint.to_account_info(),
                to: ctx.accounts.user_rewards_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            &[config_seeds],
        ),
        amount,
        ctx.accounts.rewards_mint.decimals,
    )?;
    Ok(())
}
