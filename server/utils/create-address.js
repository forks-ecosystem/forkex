'use strict';

const ethers = require('ethers');
const bitcoin = require('bitcoinjs-lib');
const bip39 = require('bip39');
const ecc = require('tiny-secp256k1')
const { BIP32Factory } = require('bip32')
const bip32 = BIP32Factory(ecc)

const { TronWeb } = require('tronweb');
const rippleKeypairs = require('ripple-keypairs');
const { Wallet: KaspaWallet } = require('@kaspa/wallet');

const createAddress = async (user_id, crypto, network) => {
  if (!user_id || !crypto) {
    throw new Error('Missing user_id or crypto');
  }

  const result = {
    user_id,
    currency: crypto,
    network,
    address: '',
    privateKey: '',
    publicKey: '',
    mnemonic: '',
    created_at: new Date().toISOString(),
    is_valid: true
  };
console.log('=== crypto: ', crypto);
  switch (crypto.toLowerCase()) {
    case 'eth':
    case 'usdt':
//    case 'usdt-erc20':
      const ethWallet = ethers.Wallet.createRandom();
      result.address = ethWallet.address;
      result.privateKey = ethWallet.privateKey;
      break;

    case 'trx':
    case 'usdt-trc20':
console.log('typeof TronWeb:', typeof TronWeb);
console.log('TronWeb:', TronWeb);

      const tronWeb = new TronWeb({
        fullHost: 'https://api.trongrid.io',
        headers: { "TRON-PRO-API-KEY": '3f289807-1178-4f64-b148-57daa62f6e21' },
        privateKey: '22a6ec4d10a4e9c7fab79da7dfa44c95f9981dd27373cedd282beaae3a907699'
      });
      const trxAccount = await tronWeb.createAccount();
      result.address = trxAccount.address.base58;
      result.privateKey = trxAccount.privateKey;
      break;
/*
    case 'btc':
      const btcMnemonic = bip39.generateMnemonic();
      const btcSeed = await bip39.mnemonicToSeed(btcMnemonic);
      const btcRoot = bip32.fromSeed(btcSeed, bitcoin.networks.bitcoin);
      const btcChild = btcRoot.derivePath("m/44'/0'/0'/0/0");
      const publicKey = Buffer.from(btcChild.publicKey)
      result.address = bitcoin.payments.p2pkh({ pubkey: publicKey, network: bitcoin.networks.bitcoin }).address;
      result.privateKey = btcChild.toWIF();
      result.publicKey = publicKey;
      result.mnemonic = btcMnemonic;
      break;
*/

    case 'btc':
      const btcMnemonic = bip39.generateMnemonic();
      const btcSeed = await bip39.mnemonicToSeed(btcMnemonic);
      const btcRoot = bip32.fromSeed(btcSeed, bitcoin.networks.bitcoin);
      const btcChild = btcRoot.derivePath("m/44'/0'/0'/0/0");
      result.address = bitcoin.payments.p2pkh({ pubkey: Buffer.from(btcChild.publicKey), network: bitcoin.networks.bitcoin }).address;
      result.privateKey = btcChild.toWIF();
      break;

    case 'ltc':
      const ltcMnemonic = bip39.generateMnemonic();
      const ltcSeed = await bip39.mnemonicToSeed(ltcMnemonic);
      const ltcRoot = bip32.fromSeed(ltcSeed, bitcoin.networks.litecoin);
      const ltcChild = ltcRoot.derivePath("m/44'/2'/0'/0/0");
      result.address = bitcoin.payments.p2pkh({ pubkey: Buffer.from(ltcChild.publicKey), network: bitcoin.networks.litecoin }).address;
      result.privateKey = ltcChild.toWIF();
      break;

    case 'doge':
      const dogeMnemonic = bip39.generateMnemonic();
      const dogeSeed = await bip39.mnemonicToSeed(dogeMnemonic);
      const dogeRoot = bip32.fromSeed(dogeSeed, {
        messagePrefix: '\x19Dogecoin Signed Message:\n',
        bech32: 'doge',
        bip32: {
          public: 0x02facafd,
          private: 0x02fac398
        },
        pubKeyHash: 0x1e,
        scriptHash: 0x16,
        wif: 0x9e
      });
      const dogeChild = dogeRoot.derivePath("m/44'/3'/0'/0/0");
      result.address = bitcoin.payments.p2pkh({ pubkey: Buffer.from(dogeChild.publicKey), network: {
        messagePrefix: '\x19Dogecoin Signed Message:\n',
        bech32: 'doge',
        bip32: {
          public: 0x02facafd,
          private: 0x02fac398
        },
        pubKeyHash: 0x1e,
        scriptHash: 0x16,
        wif: 0x9e
      }}).address;
      result.privateKey = dogeChild.toWIF();
      break;

    case 'xrp':
      const xrpAccount = rippleKeypairs.generate();
      result.address = rippleKeypairs.deriveAddress(xrpAccount.publicKey);
      result.privateKey = xrpAccount.privateKey;
      break;

    case 'kas':
      const kasWallet = await KaspaWallet.fromMnemonic(bip39.generateMnemonic(), { network: 'kaspa' }, { disableAddressDerivation: true });
      result.address = kasWallet.receiveAddress;
      result.privateKey = kasWallet.privateKey;
      break;

    case 'gor':
      const gorWallet2 = await KaspaWallet.fromMnemonic(bip39.generateMnemonic(), { network: 'kaspa' }, { disableAddressDerivation: true });
      result.address = gorWallet2.receiveAddress;
      result.privateKey = gorWallet2.privateKey;
      break;

    default:
      throw new Error(`Unsupported currency: ${crypto}`);
  }

  return result;
};
module.exports = {
  createAddress
};