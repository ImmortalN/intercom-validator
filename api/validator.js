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
    log('Запуск перевірки Presale чатів з пагінацією та team_assignee_id...');
    
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

    let startingAfter = null; // Маркер для наступної сторінки

    try {
        do {
            // Формуємо тіло запиту
            const searchBody = {
                query: {
                    operator: 'AND',
                    value: [
                        { field: 'state', operator: '=', value: 'snoozed' },
                        // ЗМІНА 1: використовуємо team_assignee_id замість assignee_id
                        { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                        { field: 'updated_at', operator: '<', value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 50 } // ЗМІНА 2: додаємо ліміт на сторінку
            };

            // Якщо це не перша сторінка, додаємо маркер starting_after
            if (startingAfter) {
                searchBody.pagination.starting_after = startingAfter;
            }

            const searchRes = await axios.post('https://api.intercom.io/conversations/search', searchBody, {
                headers: { 
                    'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                    'Accept': 'application/json', 
                    'Intercom-Version': INTERCOM_VERSION 
                }
            });

            const chats = searchRes.data.conversations || [];
            log(`Знайдено чатів на сторінці: ${chats.length}`);

            for (const chat of chats) {
                // Перевірка Follow-Up (використовуємо тег або аттрибут, як у вашому проекті)
                const hasFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR];
                
                if (hasFollowUp === true) {
                    log(`Чат ${chat.id} пропущено (Follow-Up: true)`);
                    continue;
                }

                try {
                    // Додаємо внутрішню замітку
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/notes`, {
                        admin_id: ADMIN_ID,
                        body: PRESALE_NOTE_TEXT
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });

                    // Переставляємо снуз на 1 хвилину
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/parts`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        action: 'snooze',
                        snoozed_until: Math.floor(Date.now() / 1000) + 60
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } });

                    log(`Чат ${chat.id} успішно оброблено`);
                } catch (e) {
                    log(`Помилка при обробці чату ${chat.id}:`, e.message);
                }
            }

            // Отримуємо маркер наступної сторінки з відповіді Intercom
            startingAfter = searchRes.data.pages?.next?.starting_after;

        } while (startingAfter); // Цикл триває, поки Intercom видає наступну сторінку

        log('Перевірку всіх сторінок завершено.');

    } catch (err) {
        log('Помилка при пошуку Presale чатів:', err.response?.data || err.message);
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
