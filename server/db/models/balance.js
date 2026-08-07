'use strict';

module.exports = (sequelize, DataTypes) => {
  const Balance = sequelize.define('Balance', {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER,
    },

    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    currency: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },

    balance: {
      type: DataTypes.DECIMAL(32, 16),
      allowNull: false,
      defaultValue: 0,
    },

    available: {
      type: DataTypes.DECIMAL(32, 16),
      allowNull: false,
      defaultValue: 0,
    },

    locked: {
      type: DataTypes.DECIMAL(32, 10),
      allowNull: true,
      defaultValue: 0,
    },

    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'balances',
    timestamps: false,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['user_id', 'currency'],
      },
    ],
    hooks: {
      afterUpdate: async (balance) => {
        await syncUserWallet(balance);
      },
      afterCreate: async (balance) => {
        await syncUserWallet(balance);
      },
    },
  });

  Balance.associate = function(models) {
    Balance.belongsTo(models.User, {
      foreignKey: 'user_id',
      as: 'user',
    });

    Balance.belongsTo(models.Coin, {
      foreignKey: 'currency',
      targetKey: 'symbol',
      as: 'coin',
    });
  };

  return Balance;
};

async function syncUserWallet(balance) {
  try {
    const { UserCoin } = require('../models');
    const Sequelize = require('sequelize');
    const sql = `
      INSERT INTO user_wallets (user_id, currency, balance, available, address, network, is_valid, created_at, updated_at)
      SELECT :user_id, :currency, :balance, :available,
        COALESCE((SELECT address FROM user_wallets WHERE user_id = :user_id AND currency = :currency LIMIT 1), ''),
        COALESCE((SELECT network FROM user_wallets WHERE user_id = :user_id AND currency = :currency LIMIT 1), ''),
        true, NOW(), NOW()
      ON CONFLICT (user_id, currency)
      DO UPDATE SET
        balance = EXCLUDED.balance,
        available = EXCLUDED.available,
        updated_at = NOW()
    `;
    await sequelize.query(sql, {
      replacements: {
        user_id: balance.user_id,
        currency: balance.currency,
        balance: balance.balance,
        available: balance.available,
      },
      type: sequelize.QueryTypes.INSERT,
    });
  } catch (err) {
    // Don't break the main operation if sync fails
    console.error('syncUserWallet error:', err.message);
  }
}
