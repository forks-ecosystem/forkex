const { GorWallet } = require('@okxweb3/coin-gor');
const multichainWallet = require('multichain-crypto-wallet');

/**
 * Генерирует GOR-кошелёк: мнемоника, приватный/публичный ключи, адрес
 * @returns {Promise<{ mnemonic: string, address: string, privateKey: string, publicKey: string }>}
 */
async function generateGorWallet() {
    // 1. Сгенерим мнемонику
    const mnemonic = multichainWallet.generateMnemonic({
        strength: 256,
        language: 'english'
    });

    // 2. Получим приватный ключ
    const wallet = new GorWallet();
    const privateKey = await wallet.getDerivedPrivateKey({
        mnemonic,
        hdPath: "m/44'/100001'/0'/0/0"
    });

    // 3. Получим адрес и публичный ключ
    const { address, publicKey } = await wallet.getNewAddress({ privateKey });

    return {
        mnemonic,
        address,
        privateKey,
        publicKey
    };
}

// Экспорт функции для использования в других файлах
module.exports = { generateGorWallet };
