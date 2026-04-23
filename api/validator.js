const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Нужен ноут по пресейлу';
const INTERCOM_VERSION = '2.14';
const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';

// Вспомогательная функция для логов
function log(message, data = '') {
    console.log(`[${new Date().toISOString()}] ${message}`, data);
}

// === ЛОГИКА 1 & 2: UNPAID И SUBSCRIPTION ===
async function validateAndCheckSubscription(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id;

    if (!contactId) return;

    try {
        // Получаем данные контакта
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });

        const contact = contactRes.data;
        const email = contact.email;
        const purchaseEmail = contact.custom_attributes?.['Purchase email'];

        // 1. Проверка Unpaid
        if (email || purchaseEmail) {
            const listRes = await axios.get(LIST_URL);
            const unpaidList = listRes.data; 
            
            const isUnpaid = unpaidList.includes(email) || (purchaseEmail && unpaidList.includes(purchaseEmail));

            if (isUnpaid) {
                await axios.put(`https://api.intercom.io/contacts/${contactId}`, 
                { custom_attributes: { [CUSTOM_ATTR_NAME]: true } },
                { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });
                log(`Attribute ${CUSTOM_ATTR_NAME} set for ${contactId}`);
            }
        }

        // 2. Проверка Subscription
        const subscription = contact.custom_attributes?.['subscription'];
        if (!subscription) {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/notes`, {
                admin_id: ADMIN_ID,
                body: "Please fill subscription"
            }, {
                headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION }
            });
            log(`Subscription note sent to conversation ${conversationId}`);
        }

    } catch (err) {
        log('Error in Unpaid/Subscription logic:', err.message);
    }
}

// === ЛОГИКА 3: PRESALE (ОБНОВЛЕННАЯ) ===
async function checkPresaleSnoozedChats() {
    log('Запуск перевірки Presale чатів...');
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

    let startingAfter = null;

    try {
        do {
            // Формуємо чистий об'єкт запиту
            const searchBody = {
                query: {
                    operator: 'AND',
                    value: [
                        { field: 'state', operator: '=', value: 'snoozed' },
                        { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                        { field: 'updated_at', operator: '<', value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 50 }
            };

            // Додаємо маркер пагінації тільки якщо він реально існує
            if (startingAfter && startingAfter !== "") {
                searchBody.pagination.starting_after = startingAfter;
            }

            const searchRes = await axios.post('https://api.intercom.io/conversations/search', searchBody, {
                headers: { 
                    'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                    'Accept': 'application/json', 
                    'Intercom-Version': INTERCOM_VERSION 
                },
                timeout: 15000 // Збільшив таймаут для пошуку
            });

            const chats = searchRes.data.conversations || [];
            log(`Знайдено чатів на сторінці: ${chats.length}`);

            for (const chat of chats) {
                const hasFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR];
                if (hasFollowUp === true) continue;

                try {
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/notes`, {
                        admin_id: ADMIN_ID,
                        body: PRESALE_NOTE_TEXT
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });

                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/parts`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        action: 'snooze',
                        snoozed_until: Math.floor(Date.now() / 1000) + 60
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });

                    log(`Чат ${chat.id} оброблено`);
                } catch (e) {
                    log(`Помилка в чаті ${chat.id}: ${e.message}`);
                }
            }

            startingAfter = searchRes.data.pages?.next?.starting_after;

        } while (startingAfter);

        log('Всі сторінки оброблено успішно.');

    } catch (err) {
        // Тут ми побачимо реальну причину помилки 400
        const errorData = err.response?.data?.errors;
        log('ПОМИЛКА ПОШУКУ:', errorData ? JSON.stringify(errorData) : err.message);
    }
}

// === WEBHOOK ENDPOINT ===
app.post('/webhook', async (req, res) => {
    const data = req.body;
    const topic = data.topic;

    // Срабатывает на новые сообщения (Unpaid & Subscription)
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        validateAndCheckSubscription(data.data.item);
    }

    // Срабатывает, когда агент выходит из Away (Presale Trigger)
    if (topic === 'admin.away_mode_updated' && data.data.item.away_mode_enabled === false) {
        log(`Агент ${data.data.item.id} вернулся. Запускаем поиск...`);
        checkPresaleSnoozedChats();
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`Сервер запущен на порту ${PORT}`));
