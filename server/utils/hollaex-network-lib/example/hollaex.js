const Network = require('./index');

const network = new Network({
	apiUrl: 'https://forkex.life',
	apiKey: '40bf98ad7d09cd3252ce9618be0cd74955f4c804',
	apiSecret: '14e98aa9b741767ccb8ce9693837d96c83451fb39c81f399f1',
	activation_code: '7cfa7eab-9b21-4037-ae28-lbfa39ca98a3',
	exchange_id: 1
});

(async () => {
	try {
		const init = await network.init();
		console.log(init);
		console.log(network.exchange_id)

		console.log('connecting to websocket')
		network.connect(['orderbook:xht-usdt']);
		network.ws.on('message', (data) => {
			console.log(data)
		})

	} catch (err) {
		console.log(err)
	}
	
	

}) ();