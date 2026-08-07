'use strict';

module.exports = (sequelize, DataTypes) => {
  const Orderbook = sequelize.define('Orderbook', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    pair_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Pairs',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    bid_price: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    ask_price: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    bid_quantity: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    ask_quantity: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    timestamp: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'timestamp',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'created_at',
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'updated_at',
    },
  }, {
    tableName: 'Orderbooks',
    timestamps: true,
    underscored: true,
  });
  Orderbook.associate = function(models) {
    Orderbook.belongsTo(models.Pair, { foreignKey: 'pair_id', as: 'pair' });
  };
  return Orderbook;
};
