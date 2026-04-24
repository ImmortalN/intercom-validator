const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// === НАСТРОЙКИ И ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вернулся — проверяем snoozed чаты presale';
const INTERCOM_VERSION = '2.14';

// === БАЗОВАЯ ФУНКЦИЯ ДЛЯ ЗАПРОСОВ К INTERCOM ===
async function intercomRequest(method, endpoint, data = null) {
    try {
        const url = `https://api.intercom.io${endpoint}`;
        const config = {
            method: method,
            url: url,
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION,
            }
        };
        if (data) {
            config.data = data;
            config.headers['Content-Type'] = 'application/json';
        }
        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error(`[INTERCOM API ERROR] ${method.toUpperCase()} ${endpoint} -`, error.response?.data || error.message);
        throw error;
    }
}

// === ЛОГИКА 1: UNPAID & SUBSCRIPTION ===
async function handleConversationOrMessage(conversationId, contactId) {
    console.log(`[UNPAID/SUB] Начинаем проверку для чата: ${conversationId}, контакт: ${contactId}`);
    try {
        // 1. Получаем данные контакта
        const contactData = await intercomRequest('get', `/contacts/${contactId}`);
        const email = contactData.email;
        const customAttributes = contactData.custom_attributes || {};
        const purchaseEmail = customAttributes['Purchase email'];
        const subscription = customAttributes['subscription'];

        console.log(`[UNPAID/SUB] Данные контакта ${contactId}: Email=${email}, PurchaseEmail=${purchaseEmail}, Subscription=${subscription || 'ПУСТО'}`);

        // 2. Проверка подписки (Subscription)
        if (!subscription) {
            console.log(`[SUBSCRIPTION] Поле subscription пустое. Отправляем внутреннюю заметку.`);
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription'
            });
            console.log(`[SUBSCRIPTION] Заметка успешно отправлена в чат ${conversationId}`);
        }

        // 3. Проверка Unpaid (сверка email)
        if (email || purchaseEmail) {
            console.log(`[UNPAID] Запрашиваем внешний список по URL: ${LIST_URL}`);
            // Здесь должна быть ваша логика запроса к API списка (LIST_URL)
            // Имитация для примера:
            // const listResponse = await axios.get(LIST_URL);
            // const isMatch = listResponse.data.includes(email) || listResponse.data.includes(purchaseEmail);
            
            // Если совпадение найдено:
            const isMatch = true; // Замените на реальную проверку
            if (isMatch) {
                console.log(`[UNPAID] Найдено совпадение! Устанавливаем атрибут ${CUSTOM_ATTR_NAME} = true`);
                await intercomRequest('put', `/contacts/${contactId}`, {
                    custom_attributes: { [CUSTOM_ATTR_NAME]: true }
                });
            } else {
                console.log(`[UNPAID] Совпадений email во внешнем списке не найдено.`);
            }
        }
    } catch (error) {
        console.error(`[UNPAID/SUB ERROR] Ошибка при обработке чата ${conversationId}:`, error.message);
    }
}

// === ЛОГИКА 2 И 3: PRESALE TRIGGER & ACTION ===
async function checkPresaleSnoozedChats() {
    console.log(`[PRESALE_ACTION] Запуск поиска snoozed чатов для команды ${PRESALE_TEAM_ID}...`);
    
    // Определяем полночь сегодняшнего дня для проверки updated_at
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

    console.log(`[PRESALE_ACTION] Ищем чаты, обновленные до: ${startOfTodayUnix} (Unix timestamp)`);

    try {
        // Использование team_assignee_id согласно вашему требованию
        const searchQuery = {
            query: {
                operator: 'AND',
                value: [
                    { field: 'state', operator: '=', value: 'snoozed' },
                    { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                    { field: 'updated_at', operator: '<', value: startOfTodayUnix }
                ]
            }
        };

        console.log(`[SEARCH] Отправка запроса поиска:`, JSON.stringify(searchQuery, null, 2));

        const searchRes = await intercomRequest('post', '/conversations/search', searchQuery);
        const conversations = searchRes.conversations || [];

        console.log(`[SEARCH] Найдено чатов по фильтрам: ${conversations.length}`);

        for (const conv of conversations) {
            console.log(`[PRESALE_ACTION] Обработка чата ${conv.id}...`);
            const customAttributes = conv.custom_attributes || {};
            
            if (customAttributes[FOLLOW_UP_ATTR] === true || customAttributes[FOLLOW_UP_ATTR] === 'true') {
                console.log(`[PRESALE_ACTION] Чат ${conv.id} пропущен: стоит атрибут ${FOLLOW_UP_ATTR} = true`);
                continue;
            }

            console.log(`[PRESALE_ACTION] Чат ${conv.id} подходит. Отправляем заметку и переводим snooze на 1 минуту.`);
            
            // 1. Отправляем заметку
            await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: PRESALE_NOTE_TEXT
            });

            // 2. Устанавливаем снуз на 1 минуту вперед
            const oneMinuteSnooze = Math.floor(Date.now() / 1000) + 60;
            await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                message_type: 'snoozed',
                admin_id: ADMIN_ID,
                snoozed_until: oneMinuteSnooze
            });

            console.log(`[PRESALE_ACTION] Чат ${conv.id} успешно обработан и заснужен до ${oneMinuteSnooze}`);
        }
    } catch (error) {
        console.error(`[PRESALE_ACTION ERROR] Сбой при поиске или обработке пресейл чатов:`, error.message);
    }
}

// === ГЛАВНЫЙ ОБРАБОТЧИК ВЕБХУКОВ ===
app.post('/validate-email', async (req, res) => {
    // Сразу отвечаем Intercom, чтобы избежать таймаута на вебхуке
    res.status(200).json({ ok: true });

    const body = req.body;
    const topic = body?.topic;
    
    console.log(`\n[WEBHOOK RECEIVE] Получен топик: ${topic}`);

    if (!topic) {
        console.log(`[WEBHOOK] Нет топика в теле запроса, игнорируем.`);
        return;
    }

    try {
        // Сценарий 1: Изменение статуса агента (Presale Trigger)
        if (topic === 'admin.away_mode_updated') {
            const adminId = body.data?.item?.admin?.id || body.data?.item?.id;
            const awayModeEnabled = body.data?.item?.away_mode_enabled;
            
            console.log(`[PRESALE_TRIGGER] Изменен Away Mode. Admin ID: ${adminId}, Away Mode: ${awayModeEnabled}`);

            // Если агент вышел на смену (выключил away_mode)
            if (awayModeEnabled === false) {
                console.log(`[PRESALE_TRIGGER] Агент ${adminId} вернулся (away_mode = false). Запускаем проверку пресейл чатов.`);
                await checkPresaleSnoozedChats();
            } else {
                console.log(`[PRESALE_TRIGGER] Агент ${adminId} ушел (away_mode = true). Ничего не делаем.`);
            }
        } 
        
        // Сценарий 2: Создание сообщения/чата (Unpaid & Subscription)
        else if (topic === 'conversation.user.created' || topic === 'conversation.admin.replied') {
            const conversationId = body.data?.item?.id;
            const contactId = body.data?.item?.user?.id || body.data?.item?.contacts?.contacts[0]?.id;
            
            if (conversationId && contactId) {
                await handleConversationOrMessage(conversationId, contactId);
            } else {
                console.log(`[UNPAID/SUB] Недостаточно данных в вебхуке (нет conversationId или contactId).`);
            }
        }
        else {
            console.log(`[WEBHOOK] Топик ${topic} не обрабатывается данным скриптом.`);
        }
    } catch (error) {
        console.error(`[WEBHOOK GLOBAL ERROR] Ошибка обработки вебхука:`, error.message);
    }
});

app.head('/validate-email', (req, res) => res.status(200).send());

// Для локального тестирования (Vercel сам управляет портами, но это полезно для консоли)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен. Ожидание вебхуков...`);
});

module.exports = app;
