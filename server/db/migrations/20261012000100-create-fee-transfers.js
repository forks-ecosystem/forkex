'use strict';

// fee_transfers records each FEE_SWEEP: the on-chain move of accumulated
// exchange fees from the hot wallet to the dedicated fee wallet. It is an
// internal relocation of owned funds (no user balance changes), so the only
// durable record is this row plus the fee_ledger.reference_id back-pointers.
//
// The table may already exist (created by hand while bringing the fee model up),
// so up() is idempotent.

const TABLE = 'fee_transfers';

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
				type: Sequelize.INTEGER
			},
			coin_id: {
				type: Sequelize.INTEGER,
				allowNull: false,
				references: { model: 'coins', key: 'id' }
			},
			amount: {
				type: Sequelize.DECIMAL(28, 10),
				allowNull: false
			},
			fee_address: {
				type: Sequelize.TEXT,
				allowNull: false
			},
			tx_hash: {
				type: Sequelize.TEXT,
				allowNull: true
			},
			status: {
				type: Sequelize.TEXT,
				allowNull: false,
				defaultValue: 'pending'
			},
			comment: {
				type: Sequelize.TEXT,
				allowNull: true
			},
			created_by: {
				type: Sequelize.INTEGER,
				allowNull: true
			},
			created_at: {
				allowNull: false,
				type: Sequelize.DATE,
				defaultValue: Sequelize.literal('NOW()')
			},
			confirmed_at: {
				type: Sequelize.DATE,
				allowNull: true
			}
		});
		await queryInterface.addIndex(TABLE, ['coin_id'], { name: 'idx_fee_transfers_coin' });
		await queryInterface.addIndex(TABLE, ['created_at'], { name: 'idx_fee_transfers_date' });
		await queryInterface.addIndex(TABLE, ['status'], { name: 'idx_fee_transfers_status' });
	},
	down: (queryInterface) => queryInterface.dropTable(TABLE)
};
