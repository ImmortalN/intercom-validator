const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === НАСТРОЙКИ (Variables) ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const ADMIN_ID = process.env.ADMIN_ID; // Системный ID для расснуживания
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'PRESALE_FOLLOW_UP_REMINDER';

const INTERCOM_VERSION = '2.14';
const FOLLOW_UP_ATTR = 'Follow-Up';
const UNPAID_ATTR_NAME = 'Unpaid Custom';

// Временная память, чтобы не спамить ноутами в один чат по нескольку раз за день
const processedToday = new Map();

// --- Вспомогательная функция для API ---
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

// Проверка: был ли чат изменен вчера или раньше
function isNextWorkingDay(updatedAt) {
    const lastUpdate = new Date(updatedAt * 1000);
    const now = new Date();
    lastUpdate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    return now > lastUpdate;
}

// --- ФУНКЦИЯ 1 & 2: Проверка Email и Поля Subscription ---
async function validateCustomerData(contactId, conversationId) {
    console.log(`[Validation] Проверка клиента ${contactId} в чате ${conversationId}`);
    try {
        // Получаем данные контакта
        const contactRes = await intercomApi('get', `contacts/${contactId}`);
        const contact = contactRes.data;

        // 1. Проверка по списку email
        if (LIST_URL && contact.email) {
            const listRes = await axios.get(LIST_URL);
            const unpaidEmails = listRes.data || [];
            if (unpaidEmails.includes(contact.email)) {
                console.log(`[Validation] Нашли email в списке Unpaid. Ставим атрибут.`);
                await intercomApi('put', `contacts/${contactId}`, {
                    custom_attributes: { [UNPAID_ATTR_NAME]: true }
                });
            }
        }

        // 2. Проверка поля subscription
        const subValue = contact.custom_attributes?.subscription;
        if (!subValue || subValue === "" || subValue === null) {
            console.log(`[Validation] Поле subscription пустое. Пишем ноут.`);
            await intercomApi('post', `conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'У клиента не заполнено поле subscription!'
            });
        }
    } catch (err) {
        console.error('[Validation Error]', err.message);
    }
}

// --- ФУНКЦИЯ 3: Логика Presale (Расснуживание) ---
async function processPresaleChats() {
    console.log(`[Presale] Запуск проверки снуз-чатов команды ${PRESALE_TEAM_ID}`);
    try {
        const res = await intercomApi('get', `conversations?team_id=${PRESALE_TEAM_ID}&state=snoozed`);
        const conversations = res.data.conversations || [];

        for (const convSummary of conversations) {
            const convId = convSummary.id;
            const todayStr = new Date().toISOString().split('T')[0];

            if (processedToday.get(convId) === todayStr) continue;

            const fullConv = await intercomApi('get', `conversations/${convId}`);
            const data = fullConv.data;

            // Проверка условий: нет атрибута Follow-Up и чат "вчерашний"
            const isFollowUp = data.custom_attributes?.[FOLLOW_UP_ATTR] === true || data.custom_attributes?.[FOLLOW_UP_ATTR] === 'true';
            const isOldEnough = isNextWorkingDay(data.updated_at);

            if (!isFollowUp && isOldEnough) {
                console.log(`[Presale] Чат ${convId} подходит. Расснуживаю через системного админа ${ADMIN_ID}`);
                
                // Сначала ОТКРЫВАЕМ (это расснуживает), потом НОУТ
                await intercomApi('post', `conversations/${convId}/reply`, {
                    message_type: 'open',
                    admin_id: ADMIN_ID
                });

                await intercomApi('post', `conversations/${convId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                processedToday.set(convId, todayStr);
            }
        }
    } catch (err) {
        console.error('[Presale Error]', err.response?.data || err.message);
    }
}

// --- ГЛАВНЫЙ ОБРАБОТЧИК (Webhook) ---
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.sendStatus(200);

    // СОБЫТИЕ: Новое сообщение или новый чат (для Email и Subscription)
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.user?.id;
        if (contactId) {
            validateCustomerData(contactId, item.id);
        }
    }

    // СОБЫТИЕ: Админ зашел в онлайн (для Presale)
    const isLogin = (topic === 'admin.logged_in');
    const isBack = (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false);

    if (isLogin || isBack) {
        processPresaleChats();
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Full Validator Server running on port ${PORT}`));
