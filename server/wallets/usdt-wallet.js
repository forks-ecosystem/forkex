const { ECPairFactory } = require('ecpair');
const ecc = require('tiny-secp256k1');
const bip32 = require('bip32');
const bip39 = require('bip39');
const { keccak256 } = require('ethereumjs-util');

const ECPair = ECPairFactory(ecc);

function generate(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.default(ecc).fromSeed(seed);
    const child = root.derivePath("m/44'/60'/0'/0/0");
    const keyPair = ECPair.fromPrivateKey(child.privateKey);
    const pubkey = Buffer.from(keyPair.publicKey);
    const hash = keccak256(pubkey.slice(1));
    const address = '0x' + hash.slice(-20).toString('hex');

    return {
        address,
        publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
        privateKey: Buffer.from(child.privateKey).toString('hex'),
    };
}

module.exports = { generate };
