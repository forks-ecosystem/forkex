'use strict';

// doc174: fee segregation by named wallet, not by address. wallet_purpose was
// pure seed data with no notion of whether a purpose is an on-chain block or an
// internal ledger account. This adds that distinction and records the fee/bot
// blocks:
//
//   * fee_withdrawal — on-chain, holds withdrawal commissions (swept here from
//     the operational `withdrawal` buffer by scripts/fee-sweep.js);
//   * fee_trade      — on-chain, holds trade commissions once converted out of
//     the internal ledger;
//   * bots           — on-chain, trading-bot operations.
//
// The legacy `fee` purpose (network fees) is renamed to `network`, because the
// network fee is a transit expense paid to miners, not exchange revenue.
//
// Idempotent — the live database may already carry these rows.

const ADDR_FEE_WITHDRAWAL = 'LbkwdH7SpPwGxSeSbZ8YeqyMStMCZ6TMrZ';
const ADDR_FEE_TRADE = 'Lb8Dbpv12ZBGqaXSnchMaEEJ8SKkLFRqUp';
const ADDR_BOTS = 'LR35Ui1tjyFNeotgAG61yVUM4dcruzaPPr';
const ADDR_WITHDRAWAL = 'LQehzjT3YXhTiQD8bVzM1suVSL2Ty3JZYB';
const LBTC_COIN_ID = 23;

module.exports = {
	up: async (queryInterface, Sequelize) => {
		const table = await queryInterface.describeTable('wallet_purpose');
		if (!table.is_onchain) {
			await queryInterface.addColumn('wallet_purpose', 'is_onchain', {
				type: Sequelize.BOOLEAN,
				allowNull: false,
				defaultValue: true
			});
		}
		if (!table.address) {
			await queryInterface.addColumn('wallet_purpose', 'address', {
				type: Sequelize.TEXT,
				allowNull: true
			});
		}
		if (!table.coin_id) {
			await queryInterface.addColumn('wallet_purpose', 'coin_id', {
				type: Sequelize.INTEGER,
				allowNull: true
			});
		}

		const now = queryInterface.sequelize;
		await now.query(
			`UPDATE wallet_purpose
			    SET purpose = 'network', description = 'сетевые комиссии (транзит)', is_onchain = true, address = NULL
			  WHERE purpose = 'fee'`
		);
		await now.query(
			`INSERT INTO wallet_purpose (purpose, description, online, is_onchain, address, coin_id) VALUES
				('fee_withdrawal', 'комиссии с выводов', 'yes', true, :fw, :coin),
				('fee_trade', 'комиссии со сделок', 'yes', true, :ft, :coin),
				('bots', 'кошелёк торговых ботов', 'yes', true, :bots, :coin)
			 ON CONFLICT (purpose) DO UPDATE SET
				description = EXCLUDED.description, online = EXCLUDED.online,
				is_onchain = EXCLUDED.is_onchain, address = EXCLUDED.address, coin_id = EXCLUDED.coin_id`,
			{ replacements: { fw: ADDR_FEE_WITHDRAWAL, ft: ADDR_FEE_TRADE, bots: ADDR_BOTS, coin: LBTC_COIN_ID } }
		);
		await now.query(
			`UPDATE wallet_purpose SET address = :wd, coin_id = :coin WHERE purpose = 'withdrawal'`,
			{ replacements: { wd: ADDR_WITHDRAWAL, coin: LBTC_COIN_ID } }
		);
	},
	down: async (queryInterface) => {
		await queryInterface.sequelize.query(
			`UPDATE wallet_purpose SET purpose = 'fee', description = 'комиссии сети' WHERE purpose = 'network'`
		);
		await queryInterface.sequelize.query(
			`DELETE FROM wallet_purpose WHERE purpose IN ('fee_withdrawal', 'fee_trade', 'bots')`
		);
		await queryInterface.removeColumn('wallet_purpose', 'is_onchain');
		await queryInterface.removeColumn('wallet_purpose', 'address');
		await queryInterface.removeColumn('wallet_purpose', 'coin_id');
	}
};
