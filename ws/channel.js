'use strict';

const channels = {};

const addSubscriber = (topic, ws) => {
	if (!channels[topic]) {
		channels[topic] = new Map();
	}
	channels[topic].set(ws.id, ws);
};

const removeSubscriber = (topic, ws, type) => {
	if (channels[topic]) {
		channels[topic].delete(ws.id);
		if (channels[topic].size === 0) {
			delete channels[topic];
		}
	}
};

const getChannels = () => channels;

module.exports = {
	addSubscriber,
	removeSubscriber,
	getChannels
};
