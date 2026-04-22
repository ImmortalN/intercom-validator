const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === НАСТРОЙКИ (замените на свои или настройте в Environment Variables) ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL; // API со списком email
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const ADMIN_ID = process.env.ADMIN_ID; // ID админа, от имени которого пишутся ноуты
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'PRESALE_NOTE_TEXT';

const INTERCOM_VERSION = '2.14';
const FOLLOW_UP_ATTR = 'Follow-Up';
const UNPAID_ATTR_NAME = 'Unpaid Custom';

// Временное хранилище обработанных чатов за сегодня (ID чата -> Дата)
const processedToday = new Map();

// --- Вспомогательные функции ---

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

// Проверка: наступил ли следующий календарный день для чата
function isNextWorkingDay(updatedAt) {
    const lastUpdate = new Date(updatedAt * 1000);
    const now = new Date();
    lastUpdate.setHours(0, 0, 0, 0);
    now.setHours(0, 0, 0, 0);
    return now > lastUpdate;
}

// --- Основная логика Presale ---

async function checkPresaleChats(adminId) {
    try {
        // Получаем снузнутые чаты команды
        const res = await intercomApi('get', `conversations?team_id=${PRESALE_TEAM_ID}&state=snoozed`);
        const conversations = res.data.conversations || [];

        for (const convSummary of conversations) {
            const convId = convSummary.id;
            const todayStr = new Date().toISOString().split('T')[0];

            // Если уже обрабатывали этот чат сегодня — пропускаем
            if (processedToday.get(convId) === todayStr) continue;

            // Получаем полные данные чата для проверки атрибутов и даты
            const fullConv = await intercomApi('get', `conversations/${convId}`);
            const data = fullConv.data;

            const isFollowUp = data.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const isOldEnough = isNextWorkingDay(data.updated_at);

            if (!isFollowUp && isOldEnough) {
                // 1. Расснуживаем
                await intercomApi('post', `conversations/${convId}/reply`, {
                    message_type: 'open',
                    admin_id: adminId
                });

                // 2. Пишем ноут
                await intercomApi('post', `conversations/${convId}/reply`, {
                    message_type: 'note',
                    admin_id: adminId,
                    body: PRESALE_NOTE_TEXT
                });

                processedToday.set(convId, todayStr);
                console.log(`[Presale] Чат ${convId} успешно обработан.`);
            }
        }
    } catch (err) {
        console.error('[Presale Error]', err.message);
    }
}

// --- Логика Email и Подписки ---

async function validateCustomer(contactId, convId) {
    try {
        const contactRes = await intercomApi('get', `contacts/${contactId}`);
        const contact = contactRes.data;

        // 1. Проверка email по внешнему списку
        if (LIST_URL) {
            const listRes = await axios.get(LIST_URL);
            const emails = listRes.data || [];
            if (emails.includes(contact.email)) {
                await intercomApi('put', `contacts/${contactId}`, {
                    custom_attributes: { [UNPAID_ATTR_NAME]: true }
                });
            }
        }

        // 2. Проверка поля subscription
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

// --- Webhook Handler ---

app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.sendStatus(200);

    // ТРИГГЕР 1: Выход агента в онлайн (Логин или отключение Away Mode)
    const isLogin = (topic === 'admin.logged_in');
    const isBack = (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false);

    if (isLogin || isBack) {
        const actingAdminId = item.id || item.admin_id;
        checkPresaleChats(actingAdminId);
    }

    // ТРИГГЕР 2: Новое сообщение (Проверка email и подписки)
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.user?.id;
        if (contactId) validateCustomer(contactId, item.id);
    }

    res.status(200).send('OK');
});

// Для проверки работоспособности
app.get('/', (req, res) => res.send('Validator is online!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
