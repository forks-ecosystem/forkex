const { ethers } = require('ethers');

// Deterministic BIP44 derivation from the mnemonic (m/44'/60'/0'/0/0).
// ethers addresses always come from the UNCOMPRESSED public key (64
// coordinate bytes), which is the EVM standard. The previous implementation
// delegated to multichain-crypto-wallet, whose createWallet silently ignores
// the mnemonic and calls ethers.Wallet.createRandom() — the address was valid
// but not derived from the seed the caller asked for.
function generate(mnemonic) {
	const wallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/0");

	return {
		address: wallet.address,
		publicKey: ethers.utils.computePublicKey(wallet.publicKey), // uncompressed, 0x04…
		privateKey: wallet.privateKey,
	};
}

module.exports = { generate };
