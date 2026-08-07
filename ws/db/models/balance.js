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
    tableName: 'Balances',
    timestamps: false,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['user_id', 'currency'],
      },
    ],
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
