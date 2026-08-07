const bip39 = require('bip39');
const { Wallet: KaspaWallet } = require('@kaspa/wallet');
const path = require('path');
const fs = require('fs');

async function generateWallet(user_id, crypto,  network) {
	const result = {
		user_id,
		currency: crypto.toLowerCase(),
		address: '',
		privateKey: '',
		publicKey: '',
		mnemonic: '',
		created_at: new Date().toISOString(),
		is_valid: true,
	};

	const mnemonic = bip39.generateMnemonic();

	switch (crypto.toLowerCase()) {
		case 'kas': {
			const kasWallet = await KaspaWallet.fromMnemonic(mnemonic, { network: 'kaspa' }, { disableAddressDerivation: true });
			result.address = kasWallet.receiveAddress;
			result.privateKey = kasWallet.privateKey;
			result.mnemonic = mnemonic;
			break;
		}
		case 'gor': {
                    const { generateGorWallet } = require('./gor-wallet.js');
		    const { address, privateKey, publicKey, mnemonic } = await generateGorWallet();
		    result.address = address;
		    result.privateKey = privateKey;
		    result.publicKey = publicKey;
		    result.mnemonic = mnemonic;
		    break;
		}
		case 'btc': {
			const btcWallet = require('./btc-wallet');
			const wallet = btcWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		case 'eth': {
			const ethWallet = require('./eth-wallet');
			const wallet = ethWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		case 'sol': {
			const solWallet = require('./Solana-wallet');
			const wallet = solWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		case 'trx': {
			const trxWallet = require('./tron-wallet');
			const wallet = await trxWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		case 'usdt': {
			const usdtWallet = require('./usdt-wallet');
			const wallet = usdtWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		case 'xht': {
			const usdtWallet = require('./usdt-wallet');
			const wallet = usdtWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		case 'lbtc': {
			const lbtcWallet = require('./lbtc-wallet');
			const wallet = lbtcWallet.generate(mnemonic);
			Object.assign(result, wallet, { mnemonic });
			break;
		}
		default:
			throw new Error(`Unsupported currency: ${crypto}`);
	}

	return result;
}

module.exports = {
	generateWallet
};
