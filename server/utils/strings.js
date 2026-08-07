'use strict';
const toolsLib = require('hollaex-tools-lib');
const DEFAULT_LANGUAGE = () => toolsLib.getKitConfig().language;
const VALID_LANGUAGES = () => toolsLib.getKitConfig().valid_languages;

const getValidLanguage = (language = DEFAULT_LANGUAGE()) => {
	if (VALID_LANGUAGES().indexOf(language) > -1) {
		return language;
	}
	return DEFAULT_LANGUAGE();
};

// Функция для получения токена из заголовков запроса (например, Authorization)
const getAuthToken = (req) => {
    const authHeader = req.headers['authorization'];  // Получаем заголовок Authorization
    if (!authHeader) {
        return null;  // Если заголовка нет, возвращаем null
    }

    // Проверяем, что заголовок начинается с "Bearer "
    const token = authHeader.startsWith('Bearer ') 
        ? authHeader.slice(7)  // Убираем "Bearer " и оставляем только токен
        : null;

    return token;
};

module.exports = {
	getValidLanguage,
        getAuthToken
};
