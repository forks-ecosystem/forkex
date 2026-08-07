import { createSelector } from 'reselect';
import { unique } from 'utils/data';

export const flipPair = (pair) => pair?.split('-').reverse().join('-');

export const getSourceOptions = (quicktrade = [], coins = {}) => {
	const tradeCoins = [];

	quicktrade
		.filter(({ active }) => !!active)
		.forEach(({ symbol }) => {
			tradeCoins.push(...symbol.split('-'));
		});

	const allCoins = Object.keys(coins).filter(
		(key) => !coins[key]?.hidden
	);

	return unique([...tradeCoins, ...allCoins]);
};

const getQuickTrade = (state) => state.app.quicktrade;

export const quicktradePairSelector = createSelector(
	[getQuickTrade],
	(quicktrade) => {
		return Object.fromEntries(
			quicktrade
				.filter(({ active }) => !!active)
				.map((data) => [data.symbol, data])
		);
	}
);
