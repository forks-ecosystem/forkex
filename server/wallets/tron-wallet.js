const TronWeb = require('tronweb');
const bip39 = require('bip39');
const secp256k1 = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bip32 = BIP32Factory(secp256k1);

async function generate(mnemonic) {
	const seedBuffer = await bip39.mnemonicToSeed(mnemonic);
	const node = bip32.fromSeed(seedBuffer).derivePath("m/44'/195'/0'/0/0");
	const privateKey = Buffer.from(node.privateKey).toString('hex');
	const address = TronWeb.utils.address.fromPrivateKey(privateKey);

	return {
		address,
		publicKey: Buffer.from(node.publicKey).toString('hex'),
		privateKey,
	};
}

module.exports = { generate };
