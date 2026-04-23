const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ================= CONFIG =================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';

const processedInSession = new Set();

// Функция логирования
function log(tag, message, data = '') {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] [${tag}]`, message, data ? JSON.stringify(data, null, 2) : '');
}

// Задержка (Rate Limiting)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function intercomRequest(method, url, data) {
    await sleep(500); // Пауза 0.5 сек перед каждым запросом
    return axios({
        method,
        url: `https://api.intercom.io${url}`,
        data,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    });
}

// ================= LOGIC: PRESALE ENGINE =================
async function processPresale() {
    log('PRESALE', 'Starting scan of snoozed chats...');
    try {
        const searchRes = await intercomRequest('post', '/conversations/search', {
            query: {
                operator: 'AND',
                value: [
                    { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                    { field: 'state', operator: '=', value: 'snoozed' }
                ]
            }
        });

        const conversations = searchRes.data.conversations || [];
        log('PRESALE', `Found ${conversations.length} snoozed chats total.`);

        const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

        for (const conv of conversations) {
            if (processedInSession.has(conv.id)) continue;

            log('PRESALE', `Checking chat details: ${conv.id}`);
            const full = await intercomRequest('get', `/conversations/${conv.id}`);
            const chat = full.data;

            const isFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const isOldEnough = chat.updated_at < startOfTodayUnix;

            if (!isFollowUp && isOldEnough) {
                log('ACTION', `Applying 1-min snooze and note to: ${conv.id}`);

                const inOneMinute = Math.floor(Date.now() / 1000) + 60;

                // 1. Используем правильный эндпоинт /snooze
                await intercomRequest('post', `/conversations/${conv.id}/snooze`, {
                    admin_id: ADMIN_ID,
                    snoozed_until: inOneMinute
                });

                // 2. Отправляем заметку
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                processedInSession.add(conv.id);
                log('SUCCESS', `Chat ${conv.id} updated.`);
            } else {
                log('SKIP', `Chat ${conv.id} not eligible. FollowUp: ${isFollowUp}, Old: ${isOldEnough}`);
            }
        }
    } catch (e) {
        log('ERR_PRESALE', 'Failed to process presale', e.response?.data || e.message);
    }
}

// ================= LOGIC: DATA AUDIT (EMAIL & SUB) =================
async function checkClientData(conversationId, contactId) {
    log('DATA_CHECK', `Auditing contact: ${contactId}`);
    try {
        const res = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = res.data;

        // 1. Email Check
        if (LIST_URL) {
            try {
                const { data: list } = await axios.get(LIST_URL);
                const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
                const match = emails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()));
                
                if (match) {
                    log('MATCH', `Email found in list. Setting ${CUSTOM_ATTR_NAME} for ${contactId}`);
                    await intercomRequest('put', `/contacts/${contactId}`, { 
                        custom_attributes: { [CUSTOM_ATTR_NAME]: true } 
                    });
                }
            } catch (err) {
                log('ERR_LIST', 'Could not fetch external email list', err.message);
            }
        }

        // 2. Subscription Check
        const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
        if (!sub || sub.toString().trim() === '') {
            log('SUB_EMPTY', `Sending reminder note to conversation ${conversationId}`);
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            });
        }
    } catch (e) {
        log('ERR_DATA_AUDIT', e.message);
    }
}

// ================= WEBHOOK ENDPOINT =================
app.post('/validate-email', async (req, res) => {
    // ЛОГ ВСЕГО ТЕЛА ЗАПРОСА (как просили)
    console.log('--- NEW WEBHOOK RECEIVED ---');
    console.log(JSON.stringify(req.body, null, 2));
    
    const { topic, data } = req.body;
    if (!data?.item) return res.sendStatus(200);

    const item = data.item;

    try {
        // Триггер Away Mode
        if (topic === 'admin.away_mode_updated') {
            const isOnline = item.away_mode_enabled === false;
            log('EVENT', `Away Mode Change. Natalie Online: ${isOnline}`);
            if (isOnline) {
                await processPresale();
            }
        }

        // Триггер Чат (новое сообщение/создание)
        if (topic.startsWith('conversation')) {
            const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;
            if (contactId && item.id) {
                await checkClientData(item.id, contactId);
            }
        }
    } catch (e) {
        log('ERR_GLOBAL', e.message);
    }

    res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
    console.log('==============================================');
    console.log('SERVER STARTED - MONITORING ACTIVE');
    console.log('==============================================');
});
