'use strict';

// withdrawal_events is an append-only audit log for the withdrawal state
// machine. It exists because a payout can fail *after* the exchange has already
// reserved (debited) the user's balance: when the node refuses the on-chain
// send, the balance is refunded and the withdrawal is marked failed, but the
// only durable trace of why was a log line that ages out. A row per stage makes
// the failure reconstructable from the database alone.
//
// Deliberately no foreign key to withdrawals: an operator may delete a failed
// withdrawal row (the reservation is already refunded, so it must not count
// against the monthly cap), and the audit trail has to outlive that deletion.
// `withdrawal_id` is kept as a plain, indexed integer for correlation.

const TABLE = 'withdrawal_events';

module.exports = {
	up: (queryInterface, Sequelize) => {
		return queryInterface
			.createTable(TABLE, {
				id: {
					allowNull: false,
					autoIncrement: true,
					primaryKey: true,
					type: Sequelize.INTEGER
				},
				withdrawal_id: {
					type: Sequelize.INTEGER,
					allowNull: true
				},
				created_at: {
					allowNull: false,
					type: Sequelize.DATE,
					defaultValue: Sequelize.literal('NOW()')
				},
				stage: {
					type: Sequelize.STRING(64),
					allowNull: false
				},
				event_type: {
					type: Sequelize.STRING(64),
					allowNull: false
				},
				status: {
					type: Sequelize.STRING(32),
					allowNull: false
				},
				error_code: {
					type: Sequelize.STRING(64),
					allowNull: true
				},
				error_message: {
					type: Sequelize.TEXT,
					allowNull: true
				},
				txid: {
					type: Sequelize.STRING(128),
					allowNull: true
				},
				details: {
					type: Sequelize.TEXT,
					allowNull: true
				}
			}, {
				timestamps: false
			})
			.then(() => queryInterface.addIndex(TABLE, ['withdrawal_id']))
			.then(() => queryInterface.addIndex(TABLE, ['created_at']));
	},
	down: (queryInterface) => queryInterface.dropTable(TABLE)
};
