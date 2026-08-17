'use strict';

module.exports = (sequelize, DataTypes) => {
  const Pair = sequelize.define('Pair', {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER
    },
    base_coin_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    quote_coin_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(20),
      defaultValue: 'active',
    },
    taker_fees: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.001,
    },
    maker_fees: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.0005,
    },
    min_size: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.0001,
    },
    max_size: {
      type: DataTypes.DOUBLE,
      defaultValue: 100.0,
    },
    symbol: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: true,
    },
    pair_base: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    pair_2: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    icon_id: {
      type: DataTypes.STRING,
      defaultValue: 'DEFAULT_ICON',
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    increment_size: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.1,
    },
    increment_price: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.0001,
    },
    code: {
      type: DataTypes.STRING(50),
      defaultValue: '',
    },
    is_public: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    estimated_price: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.0,
    },
    circuit_breaker: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    created_by: {
      type: DataTypes.INTEGER,
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
    tableName: 'pairs',
    underscored: true,
  });
  Pair.associate = function(models) {
    Pair.belongsTo(models.Coin, {    foreignKey: 'base_coin_id', as: 'base_coin' });
    Pair.belongsTo(models.Coin, {    foreignKey: 'quote_coin_id',as: 'quote_coin'});
  };

  return Pair;
};
