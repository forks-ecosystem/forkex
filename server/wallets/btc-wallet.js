const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const bip32 = require('bip32');
const bip39 = require('bip39');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

function generate(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.default(ecc).fromSeed(seed);
    const child = root.derivePath("m/44'/0'/0'/0/0");
    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey });

    return {
        address,
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        privateKey: Buffer.from(child.privateKey).toString('hex'),
    };
}

module.exports = { generate };
