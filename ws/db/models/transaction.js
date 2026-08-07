'use strict';

module.exports = (sequelize, DataTypes) => {
  const Transaction = sequelize.define('Transaction', {

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

    type: {
      type: DataTypes.STRING(20),
      allowNull: false
    },

    amount: {
      type: DataTypes.DECIMAL(32, 16),
      allowNull: false
    },

    currency: {
      type: DataTypes.STRING(10),
      allowNull: false
    },

    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pending'
    },

    fee: {
      type: DataTypes.DECIMAL(32, 16),
      defaultValue: 0
    },

    fee_currency: {
      type: DataTypes.STRING(10),
      allowNull: true
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },

    reference_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    tx_hash: {
      type: DataTypes.STRING,
      allowNull: true
    },

    address: {
      type: DataTypes.STRING,
      allowNull: true
    },

    network: {
      type: DataTypes.STRING(20),
      allowNull: true
    },

    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {}
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
    tableName: 'Transactions',
    underscored: true,
    timestamps: true
  });

  Transaction.associate = (models) => {
    Transaction.belongsTo(models.User, {
      foreignKey: 'user_id'
    });
  };

  return Transaction;
};
