const multichainWallet = require('multichain-crypto-wallet');

function generate(mnemonic) {
	const wallet = multichainWallet.createWallet({
		mnemonic,
		derivationPath: "m/44'/501'/0'/0'",
		network: 'solana',
	});

	return {
		address: wallet.address,
		publicKey: wallet.publicKey,
		privateKey: wallet.privateKey,
	};
}

module.exports = { generate };
