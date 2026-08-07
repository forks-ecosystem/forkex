'use strict';

const { DEFAULT_ORDER_RISK_PERCENTAGE } = require('../../constants');
const {
  generateHash,
  generateAffiliationCode
} = require('../../utils/security');

const ID_DATA_DEFAULT = {
  status: 0,
  type: '',
  number: '',
  issued_date: '',
  expiration_date: '',
  note: ''
};

const SETTINGS_DATA_DEFAULT = {
  notification: {
    popup_order_confirmation: true,
    popup_order_completed: true,
    popup_order_partially_filled: true,
    popup_order_new: true,
    popup_order_canceled: true
  },
  interface: {
    order_book_levels: 10,
    theme: process.env.DEFAULT_THEME || 'white',
    display_currency: process.env.NATIVE_CURRENCY || 'usdt',
  },
  language: process.env.DEFAULT_LANGUAGE || 'en',
  audio: {
    order_completed: true,
    order_partially_completed: true,
    public_trade: false
  },
  risk: {
    order_portfolio_percentage: DEFAULT_ORDER_RISK_PERCENTAGE
  },
  chat: {
    set_username: false
  }
};

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {

    id: {
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      type: DataTypes.INTEGER
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },

    password: {      type: DataTypes.STRING,      allowNull: false    },
    full_name: {      type: DataTypes.STRING,      defaultValue: ''    },
    gender: {      type: DataTypes.BOOLEAN,      defaultValue: false    },
    nationality: {      type: DataTypes.STRING,      defaultValue: ''    },
    dob: {      type: DataTypes.DATE    },
    phone_number: {      type: DataTypes.STRING,      defaultValue: ''    },
    address: {
      type: DataTypes.JSONB,
      defaultValue: {
        country: '',
        address: '',
        city: '',
        postal_code: ''
      }
    },
    id_data: {            type: DataTypes.JSONB,      defaultValue: ID_DATA_DEFAULT    },
    bank_account: {       type: DataTypes.JSONB,      defaultValue: []    },
    crypto_wallet: {      type: DataTypes.JSONB,      defaultValue: {}    },
    verification_level: { type: DataTypes.INTEGER,    defaultValue: 1    },
    email_verified: {     type: DataTypes.BOOLEAN,    defaultValue: false    },
    otp_enabled: {        type: DataTypes.BOOLEAN,    defaultValue: false    },
    activated: {          type: DataTypes.BOOLEAN,    defaultValue: true    },
    withdrawal_blocked: { type: DataTypes.DATE,      allowNull: true    },
    note: {               type: DataTypes.STRING,     defaultValue: ''    },
    username: {           type: DataTypes.STRING,     defaultValue: ''    },
    affiliation_code: {   type: DataTypes.STRING,     unique: true },
    settings: {           type: DataTypes.JSONB,      defaultValue: SETTINGS_DATA_DEFAULT    },
    flagged: {            type: DataTypes.BOOLEAN,    allowNull: false,      defaultValue: false    },
    is_admin: {           type: DataTypes.BOOLEAN,    defaultValue: false    },
    is_supervisor: {      type: DataTypes.BOOLEAN,    defaultValue: false    },
    is_support: {         type: DataTypes.BOOLEAN,    defaultValue: false    },
    is_kyc: {             type: DataTypes.BOOLEAN,    defaultValue: false    },
    is_communicator: {    type: DataTypes.BOOLEAN,    defaultValue: false    },
    affiliation_rate: {   type: DataTypes.DOUBLE,     defaultValue: 0    },
    network_id: {         type: DataTypes.INTEGER    },
    discount: {           type: DataTypes.DOUBLE,     defaultValue: 0    },
    meta: {               type: DataTypes.JSONB,      defaultValue: {}    },
    role: {               type: DataTypes.STRING,     allowNull: true    },
    google_id: {          type: DataTypes.STRING,     allowNull: true,      unique: true    },
    is_subaccount: {      type: DataTypes.BOOLEAN,    defaultValue: false    },
    createdAt: {          type: DataTypes.DATE,      field: 'created_at'    },
    updatedAt: {          type: DataTypes.DATE,      field: 'updated_at'    }
  }, {
    tableName: 'users',
    underscored: true,
    timestamps: true
  });

  User.beforeCreate(async (user) => {
    user.email = user.email.toLowerCase();
    user.username = user.email.split('@')[0];
    user.affiliation_code = generateAffiliationCode();

    const isVirtualEmail = user.email.endsWith('_virtual');
    if (!isVirtualEmail && user.password) {
      user.password = await generateHash(user.password);
    } else {
      user.password = 'virtual';
    }
  });

  User.beforeUpdate(async (user) => {
    if (user.email) {
      user.email = user.email.toLowerCase();
    }
    if (user.changed('password')) {
      user.password = await generateHash(user.password);
    }
  });

  User.associate = (models) => {
    User.hasMany(models.Balance, { foreignKey: 'user_id' });
    User.hasMany(models.Order, { foreignKey: 'user_id' });
    User.hasMany(models.Trade, { foreignKey: 'maker_id', as: 'maker_trades' });
    User.hasMany(models.Trade, { foreignKey: 'taker_id', as: 'taker_trades' });
  };

  return User;
};
