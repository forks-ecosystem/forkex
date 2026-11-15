'use strict';

// Ravencoin (RVN) — генерация адресов вне ноды (bip39/bip32, как lbtc-wallet.js).
//
// Основной путь на бирже — node-owned адреса (rvn-node-address.js: ключ
// возникает в кошельке ravend и хранится в wallet.dat). Этот модуль — офлайн
// деривация для инструментов/тестов и кросс-проверки адресов ноды.
//
// Константы взяты из src/chainparams.cpp RavenProject/Ravencoin v4.8.0 (mainnet):
//   PUBKEY_ADDRESS = 60  (0x3c) -> адрес начинается с 'R'
//   SCRIPT_ADDRESS = 122 (0x7a)
//   SECRET_KEY     = 128 (0x80)
//   BIP32: стандартные xprv/xpub (0x0488B21E / 0x0488ADE4)
//   BIP44 coin type = 175 (nExtCoinType в chainparams.cpp, НЕ 8000)
//   Segwit (bech32) у RVN нет — только P2PKH/P2SH, поэтому p2pkh.

const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const bip32 = require('bip32');
const bip39 = require('bip39');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const RVN_NETWORK = {
    messagePrefix: '\x18Raven Signed Message:\n',
    bip32: { public: 0x0488B21E, private: 0x0488ADE4 },
    pubKeyHash: 0x3c,
    scriptHash: 0x7a,
    wif: 0x80,
};

// Derivation path: m/44'/175'/0'/0/0 (BIP44 coin type 175, ключ кснения ноды).
const DERIVATION_PATH = "m/44'/175'/0'/0/0";

function generate(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.default(ecc).fromSeed(seed);
    const child = root.derivePath(DERIVATION_PATH);
    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const { address } = bitcoin.payments.p2pkh({
        pubkey: keyPair.publicKey,
        network: RVN_NETWORK,
    });

    return {
        address,
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        privateKey: Buffer.from(child.privateKey).toString('hex'),
    };
}

module.exports = { generate, RVN_NETWORK, DERIVATION_PATH };
