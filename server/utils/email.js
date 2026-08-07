const { Status } = require('../db/models');
const he = require('he');

async function GET_EMAIL(lang = 'en', type) {
    try {
        if (!type) {
            throw new Error('Email type is required');
        }

        // Приводим тип к нужному виду
        let new_type = type === 'SUSPICIOUS_LOGIN' ? 'login' : type;
        new_type = new_type.toUpperCase();

        const result = await Status.findOne({ where: { id: '1' } });
        if (!result?.dataValues?.email) {
            throw new Error('Email field not found in Status table');
        }

        const raw = result.dataValues.email;
        let parsed;

        try {
            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (error) {
            throw new Error('Failed to parse email data');
        }

        if (!parsed[lang]) {
            throw new Error(`No email templates for language: ${lang}`);
        }

        const langTemplates = parsed[lang];

        if (!langTemplates[new_type]) {
            throw new Error(`No email template found for type: ${new_type}`);
        }

        const template = langTemplates[new_type];

        if (template.html) {
            template.html = he.decode(template.html);
        }

        return {
            lang,
            type: new_type,
            template
        };
    } catch (error) {
        console.error('❌ Failed to get email templates:', error);
        throw error;
    }
}

module.exports = {
    GET_EMAIL
};
