'use strict';

const { sequelize, Balance, Transfer } = require('../db/models');

const transferAssetUtils = async (params) => {
    const {
        sender_id,
        receiver_id,
        currency,
        amount,
        transaction_id,
        description,
        email,
        category
    } = params.body;

    if (!sender_id || !receiver_id || !currency || !amount) {
        throw new Error('Missing required parameters');
    }

    const t = await sequelize.transaction();

    try {
        const senderBalance = await Balance.findOne({
            where: { user_id: sender_id, currency },
            lock: t.LOCK.UPDATE,
            transaction: t
        });

        if (!senderBalance || Number(senderBalance.available) < Number(amount)) {
            throw new Error('Insufficient balance');
        }

        const receiverBalance = await Balance.findOne({
            where: { user_id: receiver_id, currency },
            lock: t.LOCK.UPDATE,
            transaction: t
        });

        if (!receiverBalance) {
            throw new Error('Receiver balance not found');
        }

        // списываем
        senderBalance.available -= amount;
        senderBalance.balance -= amount;
        await senderBalance.save({ transaction: t });

        // зачисляем
        receiverBalance.available += Number(amount);
        receiverBalance.balance += Number(amount);
        await receiverBalance.save({ transaction: t });

        // лог трансфера
        const transfer = await Transfer.create({
            sender_id,
            receiver_id,
            currency,
            amount,
            transaction_id,
            description,
            category,
            email_sent: email
        }, { transaction: t });

        await t.commit();

        return {
            success: true,
            transfer_id: transfer.id,
            sender_id,
            receiver_id,
            currency,
            amount
        };

    } catch (error) {
        await t.rollback();
        console.error('transferAsset error:', error);
        throw new Error(error.message || 'Transfer failed');
    }
};

module.exports = {
    transferAssetUtils
};
