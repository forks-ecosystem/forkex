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
    // UNCOMPRESSED public key (65 bytes, 0x04-prefixed). The EVM address is
    // keccak256(pubkey_xy)[-20:] over the 64 coordinate bytes. ECPair defaults
    // to the compressed 33-byte key, and hashing THAT produced addresses no
    // private key controls — every deposit sent to such an address was
    // stranded. compressed:false is the fix.
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { compressed: false });
    const pubkey = Buffer.from(keyPair.publicKey);
    const hash = keccak256(pubkey.slice(1));
    const address = '0x' + hash.slice(-20).toString('hex');

    return {
        address,
        publicKey: '0x' + Buffer.from(keyPair.publicKey).toString('hex'),
        privateKey: Buffer.from(child.privateKey).toString('hex'),
    };
}

module.exports = { generate };
