'use strict';

// Split the single `fee` column on withdrawals into its two real components.
//
// `fee` was always the network fee: the LBTC path estimates it locally and
// overwrites it with whatever the chain actually charged. The exchange's own
// withdrawal fee lives in `coins.withdrawal_fee` and is advertised to users by
// GET /withdrawal/fee/:currency, but was never collected.
//
// `fee` keeps its meaning as the TOTAL surcharge debited from the user
// (network + exchange), because fx_withdrawal_guard() validates
// `amount + fee` against the available balance and sums `amount + fee` for the
// monthly cap. Changing that would silently weaken the balance check. The two
// components are stored separately so the record is auditable.
//
// Existing rows predate the exchange fee, so their whole `fee` is network fee.

module.exports = {
	up: async (queryInterface, Sequelize) => {
		// No defaultValue: with one, ADD COLUMN materialises 0 into the existing
		// rows and the backfill below can no longer tell "not yet classified" from
		// "genuinely zero", so it would silently leave network_fee = 0.
		await queryInterface.addColumn('withdrawals', 'network_fee', {
			type: Sequelize.DECIMAL(20, 10),
			allowNull: true
		});
		await queryInterface.addColumn('withdrawals', 'exchange_fee', {
			type: Sequelize.DECIMAL(20, 10),
			allowNull: true
		});

		// Unconditional on purpose: this runs once, immediately after the columns
		// appear, and at that moment no withdrawal can carry an exchange fee, so
		// every existing `fee` is network fee by construction.
		await queryInterface.sequelize.query(
			`UPDATE withdrawals
			    SET network_fee = COALESCE(fee, 0),
			        exchange_fee = 0`
		);
	},

	down: async (queryInterface) => {
		// Restore `fee` to the total charge before dropping the breakdown.
		await queryInterface.sequelize.query(
			`UPDATE withdrawals
			    SET fee = COALESCE(network_fee, 0) + COALESCE(exchange_fee, 0)`
		);
		await queryInterface.removeColumn('withdrawals', 'exchange_fee');
		await queryInterface.removeColumn('withdrawals', 'network_fee');
	}
};
