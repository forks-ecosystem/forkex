'use strict';

// fee_ledger is the double-entry-ish account of withdrawal fees. Each withdrawal
// writes two rows: EXCHANGE_FEE (what the user paid, income) and NETWORK_FEE
// (what the node actually spent, expense). The difference is what FEE_SWEEP
// later moves to the fee wallet, and `reference_id` points at that transfer.
//
// The table may already exist (it was created by hand while bringing the fee
// model up), so up() is idempotent.

const TABLE = 'fee_ledger';

module.exports = {
	up: async (queryInterface, Sequelize) => {
		const tables = await queryInterface.showAllTables();
		const present = tables
			.map((t) => (typeof t === 'string' ? t : (t.tableName || t.name)))
			.includes(TABLE);
		if (present) return;

		await queryInterface.createTable(TABLE, {
			id: {
				allowNull: false,
				autoIncrement: true,
				primaryKey: true,
				type: Sequelize.BIGINT
			},
			created_at: {
				allowNull: false,
				type: Sequelize.DATE,
				defaultValue: Sequelize.literal('NOW()')
			},
			withdrawal_id: {
				type: Sequelize.INTEGER,
				allowNull: true,
				references: { model: 'withdrawals', key: 'id' }
			},
			type: {
				type: Sequelize.STRING(24),
				allowNull: false
			},
			amount: {
				type: Sequelize.DECIMAL(20, 10),
				allowNull: false
			},
			currency: {
				type: Sequelize.STRING(10),
				allowNull: false,
				defaultValue: 'lbtc'
			},
			txid: {
				type: Sequelize.STRING(64),
				allowNull: true
			},
			status: {
				type: Sequelize.STRING(16),
				allowNull: false,
				defaultValue: 'pending'
			},
			reference_id: {
				type: Sequelize.BIGINT,
				allowNull: true
			},
			note: {
				type: Sequelize.TEXT,
				allowNull: true
			}
		});
		await queryInterface.addIndex(TABLE, ['type'], { name: 'idx_fee_ledger_type' });
		await queryInterface.addIndex(TABLE, ['withdrawal_id'], { name: 'idx_fee_ledger_withdrawal' });
	},
	down: (queryInterface) => queryInterface.dropTable(TABLE)
};
