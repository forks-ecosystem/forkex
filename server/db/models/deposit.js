'use strict';

module.exports = (sequelize, DataTypes) => {
  const Deposit = sequelize.define('Deposit', {

    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER
    },

    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    coin_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    amount: {
      type: DataTypes.DECIMAL(20, 10),
      allowNull: false
    },

    status: {
      type: DataTypes.STRING,
      allowNull: false
    },

    tx_hash: {
      type: DataTypes.STRING,
      allowNull: true
    },

    address: {
      type: DataTypes.STRING,
      allowNull: true
    },

    fee: {
      type: DataTypes.DECIMAL(20, 10),
      defaultValue: 0
    },

    createdAt: {
      type: DataTypes.DATE,
      field: 'created_at'
    },

    updatedAt: {
      type: DataTypes.DATE,
      field: 'updated_at'
    }

  }, {
    tableName: 'deposits',
    underscored: true,
    timestamps: true
  });

  Deposit.associate = (models) => {
    Deposit.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    Deposit.belongsTo(models.Coin, { foreignKey: 'coin_id', as: 'coin' });
  };

  return Deposit;
};

