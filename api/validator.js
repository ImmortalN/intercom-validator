const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ENV VARIABLES ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';
const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// Кеш для запобігання дублюванню нотаток про підписку
const processedSubscriptionConversations = new Set();

function log(...args) {
    if (DEBUG) console.log(new Date().toISOString(), ...args);
}

// === LOGIC 1 & 2: UNPAID CUSTOM & SUBSCRIPTION CHECK ===
async function validateContactAndChat(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id || item.user?.id;

    if (!contactId) return;

    try {
        // Отримуємо повні дані контакту
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Accept': 'application/json', 'Intercom-Version': INTERCOM_VERSION }
        });
        const contact = contactRes.data;

        // 1. Перевірка Unpaid Custom (через зовнішній список)
        const emailsToCheck = [contact.email, contact.custom_attributes?.purchase_email].filter(Boolean);
        if (emailsToCheck.length > 0 && LIST_URL) {
            try {
                const listRes = await axios.get(LIST_URL, { timeout: 5000 });
                const unpaidList = Array.isArray(listRes.data) ? listRes.data : [];
                const isUnpaid = emailsToCheck.some(email => unpaidList.includes(email));

                if (isUnpaid) {
                    await axios.put(`https://api.intercom.io/contacts/${contactId}`, 
                        { custom_attributes: { [CUSTOM_ATTR_NAME]: true } },
                        { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Intercom-Version': INTERCOM_VERSION } }
                    );
                    log(`[UNPAID] Контакт ${contactId} відмічено як Unpaid`);
                }
            } catch (e) {
                log(`[UNPAID ERROR] Не вдалося завантажити список: ${e.message}`);
            }
        }

        // 2. Перевірка Subscription (нотатка агенту)
        const hasSub = contact.custom_attributes?.subscription;
        if (!hasSub && !processedSubscriptionConversations.has(conversationId)) {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });
            
            processedSubscriptionConversations.add(conversationId);
            log(`[SUB] Нотатка про підписку додана в чат ${conversationId}`);
        }

    } catch (err) {
        log(`[VALIDATE ERROR] Помилка обробки чату ${conversationId}:`, err.message);
    }
}

// === LOGIC 3: PRESALE SNOOZE ACTION ===
async function checkPresaleSnoozedChats() {
    log('[ACTION] Запуск перевірки Presale чатів...');
    
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
                        { field: 'snoozed_until', operator: '<', value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 20 }
            };

            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const searchRes = await axios.post('https://api.intercom.io/conversations/search', searchBody, {
                headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
            });

            const chats = searchRes.data.conversations || [];
            for (const chat of chats) {
                if (chat.custom_attributes?.[FOLLOW_UP_ATTR] === true) continue;

                try {
                    // Додаємо нотатку
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/reply`, {
                        message_type: 'note', admin_id: ADMIN_ID, body: PRESALE_NOTE_TEXT
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });

                    // Оновлюємо снуз на +1 хв (щоб чат "сплив")
                    await axios.post(`https://api.intercom.io/conversations/${chat.id}/reply`, {
                        message_type: 'snoozed', admin_id: ADMIN_ID,
                        snoozed_until: Math.floor(Date.now() / 1000) + 60
                    }, { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });

                    log(`[PRESALE] Чат ${chat.id} активовано`);
                    await new Promise(r => setTimeout(r, 500)); // Rate limiting
                } catch (e) {
                    log(`[PRESALE FAIL] Чат ${chat.id}: ${e.message}`);
                }
            }
            startingAfter = searchRes.data.pages?.next?.starting_after;
        } while (startingAfter);
    } catch (err) {
        log('[PRESALE CRITICAL ERROR]', err.response?.data || err.message);
    }
}

// === WEBHOOK ENDPOINT ===
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.status(200).send('No item');

    // Логіка для нових повідомлень (Unpaid & Sub)
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        validateContactAndChat(item);
    }

    // Логіка для Away Mode (Presale Trigger)
    if (topic === 'admin.away_mode_updated') {
        const adminId = data.item.id;
        const isAway = data.item.away_mode_enabled;
        log(`[WEBHOOK] Статус адміна ${adminId}: Away = ${isAway}`);
        
        if (isAway === false) {
            checkPresaleSnoozedChats();
        }
    }

    res.status(200).send('OK');
});

// Додатковий метод для перевірки працездатності
app.get('/', (req, res) => res.send('Intercom Validator is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
