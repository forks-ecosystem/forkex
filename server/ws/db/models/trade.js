'use strict';

module.exports = (sequelize, DataTypes) => {
  const Trade = sequelize.define('Trade', {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER
    },

    side: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    direction: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    symbol: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    size: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },

    price: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    // 👇 новое поле quantity
    quantity: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: false,
    },

    maker_order_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    taker_order_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    timestamp: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    maker_fee: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    taker_fee: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },

    maker_fee_coin: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    taker_fee_coin: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },

    quick: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    maker_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    taker_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    maker_network_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    taker_network_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    pair_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    createdAt: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    updatedAt: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'Trades',
    underscored: true,
  });

  Trade.associate = function(models) {
    Trade.belongsTo(models.Pair, { foreignKey: 'pair_id' });
  };

  return Trade;
};
