use crate::{error::ErrorCode, SECONDS_PER_DAY};
use anchor_lang::prelude::*;
use mpl_core::{
    accounts::BaseCollectionV1,
    fetch_plugin,
    instructions::UpdateCollectionPluginV1CpiBuilder,
    types::{Attributes, Plugin, PluginType},
};

pub fn staking_rewards(
    attributes: &Attributes,
    now: i64,
    rewards_bps: u16,
    decimals: u8,
) -> Result<(i64, u64, u64)> {
    let value = |key: &str| -> Result<Option<&str>> {
        let mut matches = attributes.attribute_list.iter().filter(|a| a.key == key);
        let attribute = matches.next();
        require!(matches.next().is_none(), ErrorCode::InvalidRewardTracking);
        Ok(attribute.map(|a| a.value.as_str()))
    };
    require!(value("staked")? == Some("true"), ErrorCode::AssetNotStaked);
    let staked_at = value("staked_at")?
        .ok_or(ErrorCode::InvalidTimestamp)?
        .parse::<i64>()
        .map_err(|_| ErrorCode::InvalidTimestamp)?;
    let elapsed = now
        .checked_sub(staked_at)
        .ok_or(ErrorCode::InvalidTimestamp)?;
    require!(elapsed >= 0, ErrorCode::InvalidTimestamp);
    let claimed = value("rewards_claimed")?
        .unwrap_or("0")
        .parse::<u64>()
        .map_err(|_| ErrorCode::InvalidRewardTracking)?;
    let total = (elapsed / SECONDS_PER_DAY) as u64;
    let total = total
        .checked_mul(rewards_bps as u64)
        .and_then(|amount| {
            10u64
                .checked_pow(decimals as u32)
                .and_then(|scale| amount.checked_mul(scale))
        })
        .and_then(|amount| amount.checked_div(10000))
        .ok_or(ErrorCode::InvalidRewardsBps)?;
    let pending = total
        .checked_sub(claimed)
        .ok_or(ErrorCode::InvalidRewardTracking)?;
    Ok((staked_at, total, pending))
}

fn change_total_staked(attributes: &mut Attributes, increment: bool) -> Result<()> {
    let mut matches = attributes
        .attribute_list
        .iter_mut()
        .filter(|a| a.key == "total_staked");
    let attribute = matches.next().ok_or(ErrorCode::InvalidStakingCount)?;
    require!(matches.next().is_none(), ErrorCode::InvalidStakingCount);
    let count = attribute
        .value
        .parse::<u64>()
        .map_err(|_| ErrorCode::InvalidStakingCount)?;
    let count = if increment {
        count.checked_add(1)
    } else {
        count.checked_sub(1)
    }
    .ok_or(ErrorCode::InvalidStakingCount)?;
    attribute.value = count.to_string();
    Ok(())
}

pub fn update_total_staked<'info>(
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    mpl_core_program: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    increment: bool,
) -> Result<()> {
    let mut attributes =
        fetch_plugin::<BaseCollectionV1, Attributes>(collection, PluginType::Attributes)?.1;
    change_total_staked(&mut attributes, increment)?;
    UpdateCollectionPluginV1CpiBuilder::new(mpl_core_program)
        .collection(collection)
        .payer(payer)
        .authority(Some(authority))
        .system_program(system_program)
        .plugin(Plugin::Attributes(attributes))
        .invoke_signed(&[signer_seeds])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mpl_core::types::Attribute;

    fn attributes(values: &[(&str, &str)]) -> Attributes {
        Attributes {
            attribute_list: values
                .iter()
                .map(|(key, value)| Attribute {
                    key: key.to_string(),
                    value: value.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn claims_only_pay_unclaimed_whole_days() {
        let mut state = attributes(&[
            ("staked", "true"),
            ("staked_at", "100"),
            ("rewards_claimed", "0"),
        ]);
        let now = 100 + SECONDS_PER_DAY * 2 + SECONDS_PER_DAY / 2;
        assert_eq!(
            staking_rewards(&state, now, 10000, 6).unwrap(),
            (100, 2_000_000, 2_000_000)
        );
        state.attribute_list[2].value = "2000000".to_string();
        assert_eq!(staking_rewards(&state, now, 10000, 6).unwrap().2, 0);
        assert_eq!(
            staking_rewards(&state, 100 + SECONDS_PER_DAY * 3, 10000, 6)
                .unwrap()
                .2,
            1_000_000
        );
    }

    #[test]
    fn invalid_staking_state_is_rejected() {
        for values in [
            vec![("staked_at", "0")],
            vec![("staked", "false"), ("staked_at", "0")],
            vec![("staked", "true")],
            vec![("staked", "true"), ("staked_at", "invalid")],
            vec![("staked", "true"), ("staked_at", "101")],
            vec![
                ("staked", "true"),
                ("staked_at", "0"),
                ("rewards_claimed", "1"),
            ],
            vec![("staked", "true"), ("staked", "true"), ("staked_at", "0")],
        ] {
            assert!(staking_rewards(&attributes(&values), 100, 10000, 6).is_err());
        }
    }

    #[test]
    fn legacy_state_and_rounding_keep_original_reward_formula() {
        let state = attributes(&[("staked", "true"), ("staked_at", "0")]);
        assert_eq!(
            staking_rewards(&state, SECONDS_PER_DAY * 3, 3333, 6)
                .unwrap()
                .2,
            999900
        );
        assert!(staking_rewards(&state, i64::MAX, u16::MAX, 6).is_err());
    }

    #[test]
    fn collection_count_is_checked_and_preserves_other_attributes() {
        let mut state = attributes(&[("name", "collection"), ("total_staked", "0")]);
        assert!(change_total_staked(&mut state, false).is_err());
        change_total_staked(&mut state, true).unwrap();
        assert_eq!(state.attribute_list[1].value, "1");
        change_total_staked(&mut state, false).unwrap();
        assert_eq!(state.attribute_list[1].value, "0");
        assert_eq!(state.attribute_list[0].value, "collection");
        for values in [
            vec![],
            vec![("total_staked", "bad")],
            vec![("total_staked", "18446744073709551615")],
            vec![("total_staked", "1"), ("total_staked", "1")],
        ] {
            assert!(change_total_staked(&mut attributes(&values), true).is_err());
        }
    }
}
