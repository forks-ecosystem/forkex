// /opt/forkex/server/db/models/user_wallets.js

'use strict';
module.exports = (sequelize, DataTypes) => {
  const UserWallets = sequelize.define('user_wallets', {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users', // имя таблицы users
        key: 'id'
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
    },
    currency: {
      type: DataTypes.STRING(10),
      allowNull: false
    },
    balance: {
      type: DataTypes.DECIMAL(30, 8),
      defaultValue: 0
    },
    available: {
      type: DataTypes.DECIMAL(30, 8),
      defaultValue: 0
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    network: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    is_valid: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    created_at: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      allowNull: false,
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'user_wallets',
    underscored: true, // если в таблице используются имена с подчеркиваниями
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  UserWallets.associate = function(models) {
    // Ассоциация с пользователем
    UserWallets.belongsTo(models.users, {
      foreignKey: 'user_id',
      as: 'user'
    });
  };

  return UserWallets;
};

