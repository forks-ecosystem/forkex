'use strict';

module.exports = (sequelize, DataTypes) => {
  const Coin = sequelize.define('Coin', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    symbol: {
      type: DataTypes.STRING(10),
      allowNull: false,
      unique: true,
    },
    status: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    withdrawal_fee: {
      type: DataTypes.DECIMAL(32, 16),
    },
    min: {
      type: DataTypes.DECIMAL(32, 16),
    },
    max: {
      type: DataTypes.DECIMAL(32, 16),
    },
    increment: {
      type: DataTypes.DECIMAL(32, 16),
    },
    increment_unit: DataTypes.DECIMAL(32, 16),
    icon_url: {
      type: DataTypes.TEXT,
    },
    fullname: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    display_name: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    icon_id: {
      type: DataTypes.TEXT,
      defaultValue: 'DEFAULT_ICON',
    },
    logo: {
      type: DataTypes.TEXT,
    },
    active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    verified: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    allow_deposit: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    allow_withdrawal: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    increment_unit: {
      type: DataTypes.DECIMAL(32, 16),
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING(10),
      unique: true,
    },
    meta: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },
    estimated_price: {
      type: DataTypes.DECIMAL(32, 16),
    },
    description: {
      type: DataTypes.TEXT,
      defaultValue: '',
    },
    type: {
      type: DataTypes.STRING,
      defaultValue: 'blockchain',
    },
    network: {
      type: DataTypes.STRING,
    },
    withdrawal_fees: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },
    standard: {
      type: DataTypes.STRING,
    },
    issuer: {
      type: DataTypes.STRING,
      defaultValue: 'HollaEx',
    },
    is_risky: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    market_cap: {
      type: DataTypes.DECIMAL(32,16),
    },
    category: {
      type: DataTypes.STRING,
    },
    created_by: {
      type: DataTypes.INTEGER,
    },
    owner_id: {
      type: DataTypes.INTEGER,
    },
    is_public: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at',
    },
    updatedAt: {
      type: DataTypes.DATE,
      field: 'updated_at',
    },
  }, {
    tableName: 'coins',
    underscored: true,
    timestamps: true,
  });
  Coin.associate = function(models) {
    Coin.hasMany(models.Pair, { foreignKey: 'base_coin_id', as: 'base_pairs' });
    Coin.hasMany(models.Pair, { foreignKey: 'quote_coin_id',as: 'quote_pairs'});
    Coin.hasMany(models.Deposit, { foreignKey: 'coin_id', as: 'deposits' });
    Coin.hasMany(models.Withdrawal, { foreignKey: 'coin_id', as: 'withdrawals' });
    Coin.hasMany(models.Transaction, { foreignKey: 'coin_id', as: 'transactions' });
  };
  return Coin;
};
