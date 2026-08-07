'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.createTable('balances', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(10),
        allowNull: false,
      },
      balance: {
        type: Sequelize.DECIMAL(32, 16),
        allowNull: false,
        defaultValue: 0,
      },
      available: {
        type: Sequelize.DECIMAL(32, 16),
        allowNull: false,
        defaultValue: 0,
      },
      locked: {
        type: Sequelize.DECIMAL(32, 10),
        allowNull: true,
        defaultValue: 0,
      },
      updated_at: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
    }).then(() => {
      return queryInterface.addIndex('balances', ['user_id', 'currency'], {
        unique: true,
      });
    });
  },

  down: (queryInterface) => {
    return queryInterface.dropTable('balances');
  },
};
