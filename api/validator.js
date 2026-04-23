const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМІННІ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// === КЕШ ===
const processedSubscriptionConversations = new Set();
const lastProcessedDate = new Map(); // Зберігає adminId -> YYYY-MM-DD

function log(...args) {
    if (DEBUG) console.log(new Date().toISOString(), ...args);
}

// Логіка перевірки "один раз на день"
function canShowPresaleNote(adminId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    
    if (lastProcessedDate.get(adminId) === todayStr) {
        return false;
    }
    lastProcessedDate.set(adminId, todayStr);
    return true;
}

// === ЛОГІКА 1 & 2: UNPAID CUSTOM & SUBSCRIPTION ===
async function validateContactAndChat(item) {
    const conversationId = item.id;
    // user.id — це стандартне поле Intercom API, залишаємо як вимагає документація
    const contactId = item.contacts?.contacts?.[0]?.id || item.user?.id;

    if (!contactId) return;

    try {
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': INTERCOM_VERSION }
        });
        const contact = contactRes.data;

        // Перевірка Unpaid Custom
        const emailsToCheck = [contact.email, contact.custom_attributes?.purchase_email].filter(Boolean);
        if (emailsToCheck.length > 0 && LIST_URL) {
            try {
                const listRes = await axios.get(LIST_URL, { timeout: 8000 });
                const unpaidList = Array.isArray(listRes.data) ? listRes.data : [];
                const isUnpaid = emailsToCheck.some(email => unpaidList.includes(email));

                if (isUnpaid) {
                    await axios.put(`https://api.intercom.io/contacts/${contactId}`, 
                        { custom_attributes: { [CUSTOM_ATTR_NAME]: true } },
                        { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION }, timeout: 8000 }
                    );
                    log(`[UNPAID] Контакт ${contactId} відмічено`);
                }
            } catch (e) {
                log(`[UNPAID ERROR]`, e.message);
            }
        }

        // Перевірка Subscription
        const hasSub = contact.custom_attributes?.subscription;
        if (!hasSub && !processedSubscriptionConversations.has(conversationId)) {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });
            
            processedSubscriptionConversations.add(conversationId);
            log(`[SUB] Нотатка додана в чат ${conversationId}`);
        }

    } catch (err) {
        log(`[VALIDATE ERROR] Помилка обробки чату ${conversationId}:`, err.message);
    }
}

// === ЛОГІКА 3: PRESALE SNOOZE ACTION ===
async function checkPresaleSnoozedChats() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

    let startingAfter = null;

    try {
        do {
            const searchBody = {
                query: {
                    operator: 'AND',
                    value: [
                        { field: 'state', operator: '=', value: 'snoozed' },
                        { field: 'assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                        { field: 'updated_at', operator: '<', value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 20 }
            };

            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const searchRes = await axios.post('https://api.intercom.io/conversations/search', searchBody, {
                headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION },
                timeout: 15000
            });

            const chats = searchRes.data.conversations || [];
            log(`[PRESALE] Знайдено чатів на сторінці: ${chats.length}`);

            for (const chat of chats) {
                if (chat.custom_attributes?.[FOLLOW_UP_ATTR] === true) continue;

                try {
                    // Нотатка
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/reply`, {
                        message_type: 'note', admin_id: ADMIN_ID, body: PRESALE_NOTE_TEXT
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });

                    // Оновлення часу на +1 хв
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/reply`, {
                        message_type: 'snoozed', admin_id: ADMIN_ID,
                        snoozed_until: Math.floor(Date.now() / 1000) + 60
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });

                    log(`[PRESALE] Чат ${chat.id} успішно активовано`);
                    await new Promise(r => setTimeout(r, 1000)); // Затримка 1 сек
                } catch (e) {
                    log(`[PRESALE FAIL] Чат ${chat.id}: ${e.message}`);
                }
            }
            startingAfter = searchRes.data.pages?.next?.starting_after;
        } while (startingAfter);
        
        log('[PRESALE] Перевірку завершено.');
    } catch (err) {
        log('[PRESALE CRITICAL ERROR]', err.response?.data?.errors || err.message);
    }
}

// === WEBHOOK ENDPOINT ===
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.status(200).send('No item');

    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        validateContactAndChat(item);
    }

    if (topic === 'admin.away_mode_updated') {
        const adminId = item.id;
        const isAway = item.away_mode_enabled;
        
        log(`[WEBHOOK] Статус агента ${adminId}: Away = ${isAway}`);
        
        if (isAway === false) {
            if (canShowPresaleNote(adminId)) {
                log(`[ACTION] Агент ${adminId} повернувся! Запускаю перевірку Presale...`);
                checkPresaleSnoozedChats();
            } else {
                log(`[ACTION] Агент ${adminId} вже перевірявся сьогодні. Пропуск.`);
            }
        }
    }

    res.status(200).send('OK');
});

app.get('/', (req, res) => res.send('Intercom Validator is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
