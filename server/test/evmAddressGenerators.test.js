'use strict';

// EVM-генераторы адресов: контракт «адрес = несжатый pubkey».
//
// Инцидент 2026-11-11: wallets/usdt-wallet.js хешировал СЖАТЫЙ публичный ключ
// (33 байта), а EVM-адрес — это последние 20 байт keccak256 от НЕСЖАТОГО
// (64 байта координат). Адреса, выданные до фикса, не контролируются своими
// ключами — депозит на такой адрес зависает.
//
// Тест закрепляет два правила для ВСЕХ EVM-генераторов биржи:
//   1. address === ethers.Wallet(privateKey).address      (адрес controlled)
//   2. address === ethers.Wallet.fromMnemonic(mnemonic).address
//      (детерминированная BIP44-деривация из мнемоники)
// Генератор, попадающий в этот файл, обязан проходить оба.

const { expect } = require('chai');
const { ethers } = require('ethers');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PATH = "m/44'/60'/0'/0/0";
const GROUND_TRUTH = ethers.Wallet.fromMnemonic(MNEMONIC, PATH).address.toLowerCase();

describe('EVM address generators (uncompressed pubkey contract)', () => {
    it('usdt-wallet: адрес controlled и совпадает с BIP44-эталоном', () => {
        const w = require('../wallets/usdt-wallet').generate(MNEMONIC);
        const fromKey = new ethers.Wallet(w.privateKey).address.toLowerCase();
        expect(fromKey, 'адрес должен выводиться из privateKey').to.equal(w.address.toLowerCase());
        expect(w.address.toLowerCase(), 'деривация должна совпадать с ethers').to.equal(GROUND_TRUTH);
        expect(w.publicKey.length, 'публичный ключ должен быть несжатым (65 байт)').to.equal(132); // 0x + 130 hex
        expect(w.publicKey.slice(0, 4), 'несжатый ключ начинается с 0x04').to.equal('0x04');
    });

    it('eth-wallet: адрес controlled, детерминирован от мнемоники и совпадает с эталоном', () => {
        const w = require('../wallets/eth-wallet').generate(MNEMONIC);
        const fromKey = new ethers.Wallet(w.privateKey).address.toLowerCase();
        expect(fromKey, 'адрес должен выводиться из privateKey').to.equal(w.address.toLowerCase());
        expect(w.address.toLowerCase(), 'деривация должна совпадать с ethers').to.equal(GROUND_TRUTH);
        expect(w.publicKey.length, 'публичный ключ должен быть несжатым (65 байт)').to.equal(132);
    });

    it('повторный вызов на той же мнемонике даёт тот же адрес (HD-схема не сломана)', () => {
        const a = require('../wallets/usdt-wallet').generate(MNEMONIC);
        const b = require('../wallets/eth-wallet').generate(MNEMONIC);
        expect(a.address.toLowerCase()).to.equal(GROUND_TRUTH);
        expect(b.address.toLowerCase()).to.equal(GROUND_TRUTH);
    });
});
