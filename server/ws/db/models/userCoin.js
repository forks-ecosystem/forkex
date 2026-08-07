'use strict';

module.exports = (sequelize, DataTypes) => {
  const UserCoin = sequelize.define('UserCoin', {

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

    enabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },

    can_deposit: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },

    can_withdraw: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },

    deposit_limit_24h: {
      type: DataTypes.DECIMAL(32, 16),
      allowNull: true
    },

    withdrawal_limit_24h: {
      type: DataTypes.DECIMAL(32, 16),
      allowNull: true
    },

    custom_fee_deposit: {
      type: DataTypes.DECIMAL(20, 8),
      allowNull: true
    },

    custom_fee_withdrawal: {
      type: DataTypes.DECIMAL(20, 8),
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
    tableName: 'UserCoins',
    underscored: true,
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['user_id', 'coin_id']
      }
    ]
  });

  UserCoin.associate = (models) => {
    UserCoin.belongsTo(models.User, { foreignKey: 'user_id' });
    UserCoin.belongsTo(models.Coin, { foreignKey: 'coin_id' });
  };

  return UserCoin;
};
