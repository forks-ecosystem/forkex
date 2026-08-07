'use strict';

const { Deposit, Coin, User } = require('../db/models');
const { Op } = require('sequelize');

// Утилита для получения депозитов пользователя (требует user_id)
const getDepositsUtils = async (params) => {
  const { user_id, limit = 50, page = 1 } = params.query;
  if (!user_id) {
    throw new Error('user_id is required');
  }
  try {
    const deposits = await Deposit.findAll({
      where: { user_id },
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
      include: [{
        model: Coin,
        as: 'coin',
        attributes: ['symbol']
      }]
    });
    
    const formatted = deposits.map(d => formatDeposit(d));
    return { data: formatted };
    
  } catch (error) {
    console.error('GET /api/v2/deposits error:', error);
    throw new Error('Failed to fetch deposits');
  }
};

// Утилита для получения всех депозитов (админка)
const getAdminDepositsUtils = async (params) => {
  const { 
    limit = 50, 
    page = 1, 
    status, 
    currency, 
    email, 
    user_id,
    start_date,
    end_date,
    min_amount,
    max_amount
  } = params.query;
  
  try {
    // Базовые условия
    const whereConditions = {};
    
    // Фильтр по статусу
    if (status !== undefined) {
      whereConditions.status = status === 'true' || status === '1' || status === true;
    }
    
    // Фильтр по user_id (опционально)
    if (user_id) {
      whereConditions.user_id = user_id;
    }
    
    // Фильтр по дате
    if (start_date || end_date) {
      whereConditions.created_at = {};
      if (start_date) {
        whereConditions.created_at[Op.gte] = new Date(start_date);
      }
      if (end_date) {
        whereConditions.created_at[Op.lte] = new Date(end_date);
      }
    }
    
    // Фильтр по сумме
    if (min_amount || max_amount) {
      whereConditions.amount = {};
      if (min_amount) {
        whereConditions.amount[Op.gte] = parseFloat(min_amount);
      }
      if (max_amount) {
        whereConditions.amount[Op.lte] = parseFloat(max_amount);
      }
    }
    
    // Включаем фильтрацию по email через JOIN с User
    const include = [
      {
        model: Coin,
        as: 'coin',
        attributes: ['symbol', 'name']
      }
    ];
    
    // Добавляем JOIN с User если нужна фильтрация по email
    if (email) {
      include.push({
        model: User,
        as: 'user',
        attributes: ['id', 'email'],
        where: {
          email: {
            [Op.iLike]: `%${email}%`  // Поиск с учетом регистра
          }
        }
      });
    } else {
      // Всегда включаем User для админки
      include.push({
        model: User,
        as: 'user',
        attributes: ['id', 'email', 'full_name']
      });
    }
    
    // Фильтр по валюте через JOIN с Coin
    if (currency) {
      include[0].where = {
        symbol: {
          [Op.iLike]: `%${currency.toUpperCase()}%`
        }
      };
    }
    
    // Получаем общее количество для пагинации
    const total = await Deposit.count({
      where: whereConditions,
      include: include.filter(inc => !inc.where) // Без условий для подсчета
    });
    
    // Получаем депозиты
    const deposits = await Deposit.findAll({
      where: whereConditions,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit),
      include: include
    });
    
    // Форматируем ответ
    const formatted = deposits.map(d => formatAdminDeposit(d));
    
    return { 
      data: formatted,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    };
    
  } catch (error) {
    console.error('GET /api/v2/admin/deposits error:', error);
    throw new Error('Failed to fetch admin deposits');
  }
};

// Форматирование депозита для пользователя
const formatDeposit = (deposit) => ({
  id: deposit.id,
  user_id: deposit.user_id,
  coin_id: deposit.coin_id,
  amount: parseFloat(deposit.amount),
  status: deposit.status === '1' || deposit.status === true,
  created_at: deposit.created_at,
  updated_at: deposit.updated_at,
  currency: deposit.coin?.symbol?.toLowerCase() || '',
  symbol: deposit.coin?.symbol?.toLowerCase() || ''
});

// Форматирование депозита для админки (расширенная информация)
const formatAdminDeposit = (deposit) => ({
  id: deposit.id,
  user_id: deposit.user_id,
  user_email: deposit.user?.email || '',
  user_name: deposit.user?.full_name || '',
  coin_id: deposit.coin_id,
  coin_symbol: deposit.coin?.symbol || '',
  coin_name: deposit.coin?.name || '',
  amount: parseFloat(deposit.amount),
  amount_fiat: deposit.amount_fiat ? parseFloat(deposit.amount_fiat) : null,
  status: deposit.status === '1' || deposit.status === true,
  transaction_id: deposit.transaction_id || '',
  address: deposit.address || '',
  txid: deposit.txid || '',
  confirmations: deposit.confirmations || 0,
  required_confirmations: deposit.required_confirmations || 0,
  network: deposit.network || '',
  fee: deposit.fee ? parseFloat(deposit.fee) : null,
  note: deposit.note || '',
  created_at: deposit.created_at,
  updated_at: deposit.updated_at
});

module.exports = {
  getDepositsUtils,
  getAdminDepositsUtils,
  formatDeposit,
  formatAdminDeposit
};
