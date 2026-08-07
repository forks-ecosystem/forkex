import React, { useState, useEffect } from 'react';
import { Table, Spin } from 'antd';
import { Link } from 'react-router';
import MultiFilter from './TableFilter';
import { getExchangeBalances, getExchangeWallet } from './action';
import { requestUsers } from '../Stakes/actions';

const columns = [
	{
		title: 'User Id',
		dataIndex: 'user_id',
		key: 'user_id',
		render: (user_id) => (
			<Link to={`/admin/user?id=${user_id}`}>{user_id}</Link>
		),
	},
	{
		title: 'Currency',
		dataIndex: 'currency',
		key: 'currency',
	},
	{
		title: 'Available Balance',
		dataIndex: 'available',
		key: 'available',
		render: (available) => parseFloat(available || 0),
	},
	{
		title: 'Total Balance',
		dataIndex: 'balance',
		key: 'balance',
		render: (balance) => parseFloat(balance || 0),
	},
];

const filterFields = [
	{
		label: 'User ID',
		value: '',
		placeholder: 'Input User ID',
		type: 'number',
		name: 'user_id',
	},
	{
		label: 'Currency',
		value: '',
		placeholder: 'Currency',
		type: 'select',
		name: 'currency',
	},
	{
		label: 'Email',
		value: '',
		placeholder: 'Email',
		type: 'text',
		name: 'email',
	},
];

const filterOptions = [
	{
		label: 'User ID',
		value: 'user_id',
		name: 'user_id',
	},
	{
		label: 'Currency',
		value: 'currency',
		name: 'currency',
	},
	{
		label: 'Email',
		value: 'email',
		name: 'email',
	},
];

const Balances = () => {
	const [isLoading, setIsLoading] = useState(false);
	const [userData, setUserData] = useState([]);

	const fetchBalances = async (params = {}) => {
		setIsLoading(true);
		try {
			const res = await getExchangeWallet(params);
			if (res && res.data) {
				setUserData(res.data);
			}
		} catch (error) {
			console.error('error', error);
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		fetchBalances();
	}, []);

	const getAllUserData = async (params = {}) => {
		const currency = params?.currency && params?.currency;
		try {
			const res = await requestUsers(params);
			if (res && res.data) {
				const userDataMapped = res.data.map((user) => ({
					user_id: user.id,
					currency: currency,
				}));
				getExchangeBalances({ ...userDataMapped[0], format: 'csv' });
			}
		} catch (error) {
			console.error('error', error);
		}
	};

	const requestDownload = (fieldValues = {}) => {
		fieldValues?.email
			? getAllUserData(fieldValues)
			: getExchangeBalances({ ...fieldValues, format: 'csv' });
	};

	const onHandleFilter = (params) => {
		fetchBalances(params);
	};

	return (
		<div className="asset-exchange-wallet-wrapper">
			<div className="header-txt">Exchange balances</div>
			<div style={{ color: '#ccc', marginTop: 5 }}>
				View all user balances or download a CSV report.
			</div>
			<div className="wallet-filter-wrapper mt-4">
				<MultiFilter
					fields={filterFields}
					filterOptions={filterOptions}
					onHandle={onHandleFilter}
					setIsLoading={setIsLoading}
					isLoading={isLoading}
					buttonText={'Filter'}
					alwaysEnabled={true}
					onDownload={requestDownload}
					downloadText={'Download CSV'}
				/>
			</div>
			<div className="mt-5">
				<Spin spinning={isLoading}>
					<Table
						columns={columns}
						dataSource={userData}
						rowKey={(record) => `${record.user_id}-${record.currency}`}
						pagination={{ pageSize: 20 }}
					/>
				</Spin>
			</div>
		</div>
	);
};

export default Balances;
