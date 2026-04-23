const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === НАСТРОЙКИ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const ADMIN_ID = process.env.ADMIN_ID; 
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'PRESALE_NOTE_TEXT';

const INTERCOM_VERSION = '2.14';
const FOLLOW_UP_ATTR = 'Follow-Up';
const UNPAID_ATTR_NAME = 'Unpaid Custom';

// Хранилище обработанных чатов (ID -> Дата), чтобы не дублировать ноут в течение дня
const processedToday = new Map();

// --- Вспомогательная функция для запросов к API ---
async function intercomApi(method, endpoint, data = {}) {
    return axios({
        method,
        url: `https://api.intercom.io/${endpoint}`,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Intercom-Version': INTERCOM_VERSION
        },
        data
    });
}

// Проверка: был ли чат обновлен вчера или ранее (следующий рабочий день)
function isNextWorkingDay(updatedAt) {
    const lastUpdate = new Date(updatedAt * 1000);
    const now = new Date();
    lastUpdate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    return now > lastUpdate;
}

// --- Логика PRESALE (расснуживание + ноут) ---
async function processPresaleChats(adminId) {
    try {
        // 1. Ищем чаты команды Presale, которые сейчас в снузе
        const res = await intercomApi('get', `conversations?team_id=${PRESALE_TEAM_ID}&state=snoozed`);
        const conversations = res.data.conversations || [];

        for (const convSummary of conversations) {
            const convId = convSummary.id;
            const todayStr = new Date().toISOString().split('T')[0];

            if (processedToday.get(convId) === todayStr) continue;

            // 2. Получаем полные данные чата
            const fullConv = await intercomApi('get', `conversations/${convId}`);
            const data = fullConv.data;

            const isFollowUp = data.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const isOldEnough = isNextWorkingDay(data.updated_at);

            if (!isFollowUp && isOldEnough) {
                console.log(`[Presale] Обработка чата ${convId}...`);

                // ШАГ 1: Принудительно открываем чат (Open). 
                // Это выводит его из snooze. Клиент этого НЕ видит.
                await intercomApi('post', `conversations/${convId}/reply`, {
                    message_type: 'open',
                    admin_id: adminId
                });

                // ШАГ 2: Добавляем внутреннюю заметку для агента
                await intercomApi('post', `conversations/${convId}/reply`, {
                    message_type: 'note',
                    admin_id: adminId,
                    body: PRESALE_NOTE_TEXT
                });

                processedToday.set(convId, todayStr);
                console.log(`[SUCCESS] Чат ${convId} открыт и ноут добавлен.`);
            }
        }
    } catch (err) {
        console.error('[Presale Error]', err.response?.data || err.message);
    }
}

// --- Логика EMAIL (Unpaid) и SUBSCRIPTION ---
async function validateCustomer(contactId, convId) {
    try {
        const contactRes = await intercomApi('get', `contacts/${contactId}`);
        const contact = contactRes.data;

        // Проверка по внешнему списку email
        if (LIST_URL) {
            const listRes = await axios.get(LIST_URL);
            const emails = listRes.data || [];
            if (emails.includes(contact.email)) {
                await intercomApi('put', `contacts/${contactId}`, {
                    custom_attributes: { [UNPAID_ATTR_NAME]: true }
                });
            }
        }

        // Ноут, если нет подписки
        if (!contact.custom_attributes?.subscription) {
            await intercomApi('post', `conversations/${convId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'У клиента не заполнено поле subscription!'
            });
        }
    } catch (err) {
        console.error('[Validation Error]', err.message);
    }
}

// --- Обработчик Webhook ---
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.sendStatus(200);

    // Триггер: Админ залогинился ИЛИ отключил Away Mode
    const isLogin = (topic === 'admin.logged_in');
    const isBack = (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false);

    if (isLogin || isBack) {
        const actingAdminId = item.id || item.admin_id;
        console.log(`[Trigger] Админ ${actingAdminId} онлайн. Запуск проверки Presale.`);
        processPresaleChats(actingAdminId);
    }

    // Триггер: Новое сообщение от пользователя
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.user?.id;
        if (contactId) validateCustomer(contactId, item.id);
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
