// server/init/ticker-updater.js
'use strict';

const { loggerInit } = require('../config/logger');

class TickerUpdater {
    constructor(intervalMinutes = 5) {
        this.intervalMinutes = parseInt(intervalMinutes);
        this.updateInterval = null;
        this.isRunning = false;
        this.lastUpdate = null;
        loggerInit.info(`TickerUpdater created with ${this.intervalMinutes} min interval`);
    }

    /**
     * Запуск обновления цен
     */
    start() {
        if (this.isRunning) {
            loggerInit.warn('Ticker updater is already running');
            return false;
        }

        loggerInit.info(`Starting ticker price updater (interval: ${this.intervalMinutes} min)`);
        
        try {
            // Первоначальное обновление
            this.updatePrices();
            
            // Периодическое обновление
            this.updateInterval = setInterval(() => {
                this.updatePrices();
            }, this.intervalMinutes * 60 * 1000);
            
            this.isRunning = true;
            this.lastUpdate = new Date();
            
            loggerInit.info('Ticker price updater started successfully');
            return true;
            
        } catch (error) {
            loggerInit.error('Failed to start ticker updater:', error);
            return false;
        }
    }

    /**
     * Остановка обновления цен
     */
    stop() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        if (this.isRunning) {
            this.isRunning = false;
            loggerInit.info('Ticker price updater stopped');
            return true;
        }
        
        return false;
    }

    /**
     * Обновление цен с обработкой ошибок
     */
    async updatePrices() {
        try {
            loggerInit.debug('Updating base prices...');
            
            // Пытаемся загрузить функцию updateBasePrices
            let updateBasePrices;
            try {
                // Сначала пробуем из новой версии
                ({ updateBasePrices } = require('../utils/getTickersUtilsV2'));
            } catch (error) {
                // Потом из старой
                ({ updateBasePrices } = require('../utils/getTickersUtils'));
            }
            
            if (typeof updateBasePrices === 'function') {
                await updateBasePrices();
                this.lastUpdate = new Date();
                loggerInit.debug('Base prices updated successfully');
            } else {
                loggerInit.warn('updateBasePrices function not found, using stub');
                // Заглушка
                this.lastUpdate = new Date();
                loggerInit.debug('Mock price update completed');
            }
            
            return true;
            
        } catch (error) {
            loggerInit.error('Error updating base prices:', error.message);
            return false;
        }
    }

    /**
     * Получение статуса
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            intervalMinutes: this.intervalMinutes,
            lastUpdate: this.lastUpdate,
            nextUpdate: this.isRunning && this.lastUpdate ? 
                new Date(this.lastUpdate.getTime() + this.intervalMinutes * 60000) : null,
            pid: process.pid
        };
    }
}

// Экспортируем класс
module.exports = TickerUpdater;
