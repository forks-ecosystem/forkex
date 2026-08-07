'use strict';

module.exports = (sequelize, DataTypes) => {
  const Order = sequelize.define('Order', {
    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER,
    },
    user_id: {
      type: DataTypes.INTEGER, // исправлено с UUID
      allowNull: false,
    },
    pair_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'pairs',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    side: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    price: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    size: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'pending',
    },
    accepted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false, // исправлено с DOUBLE
    },
    accepted_amount: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.0,
    },
    symbol: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    order_id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
    },
    fee: {
      type: DataTypes.DOUBLE,
      defaultValue: 0.0,
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
    tableName: 'orders',
    underscored: true,
  });

  Order.associate = function(models) {
    Order.belongsTo(models.User, { foreignKey: 'user_id' });
    Order.belongsTo(models.Pair, { foreignKey: 'pair_id' });
  };

  return Order;
};

