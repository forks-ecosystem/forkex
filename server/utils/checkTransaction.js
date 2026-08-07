// utils/checkTransaction.js
'use strict';

const { Transaction, Deposit, Withdrawal } = require('../db/models');
const { Op } = require('sequelize');

const checkTransactionUtils = async (params) => {
    const {
        currency,
        transaction_id,
        address,
        network,
        is_testnet
    } = params.query;

    if (!currency || !transaction_id || !address || !network) {
        throw new Error('Missing required parameters');
    }

    try {
        // 1. Ищем депозит
        const deposit = await Deposit.findOne({
            where: {
                transaction_id,
                currency,
                address,
                network
            }
        });

        if (deposit) {
            return {
                type: 'deposit',
                status: deposit.status,
                amount: Number(deposit.amount),
                currency,
                transaction_id,
                address,
                network,
                created_at: deposit.created_at
            };
        }

        // 2. Ищем вывод
        const withdrawal = await Withdrawal.findOne({
            where: {
                transaction_id,
                currency,
                address,
                network
            }
        });

        if (withdrawal) {
            return {
                type: 'withdrawal',
                status: withdrawal.status,
                amount: Number(withdrawal.amount),
                currency,
                transaction_id,
                address,
                network,
                created_at: withdrawal.created_at
            };
        }

        return {
            found: false,
            transaction_id,
            currency,
            network
        };
    } catch (error) {
        console.error('checkTransaction error:', error);
        throw new Error('Failed to check transaction');
    }
};

module.exports = {
    checkTransactionUtils
};
