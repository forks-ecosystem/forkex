'use strict';

const models = require('../models');

module.exports = {
	async up(queryInterface) {
		const roleModel = models['Role'];

		const adminRole = await roleModel.findOne({ where: { role_name: 'admin' } });
		if (!adminRole) return;

		const permissions = Array.isArray(adminRole.permissions) ? adminRole.permissions : [];
		const configs = Array.isArray(adminRole.configs) ? adminRole.configs : [];

		const [role, created] = await roleModel.findOrCreate({
			where: { role_name: 'operator' },
			defaults: {
				role_name: 'operator',
				description: 'operator role with specific permissions',
				permissions,
				configs
			}
		});

		if (!created) {
			role.set('permissions', permissions);
			role.set('configs', configs);
			await role.save();
		}
	},
	async down(queryInterface) {
		await models['Role'].destroy({ where: { role_name: 'operator' } });
	}
};
