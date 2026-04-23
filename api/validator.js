const axios = require('axios');

// ================= CONFIG =================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';

// Хранилище для сессии (на Vercel может очищаться, что нам и нужно для сброса лимитов)
const processedInSession = new Set();

function log(tag, message, data = '') {
    console.log(`[${new Date().toLocaleTimeString()}] [${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

async function intercomRequest(method, url, data) {
    return axios({
        method,
        url: `https://api.intercom.io${url}`,
        data,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        timeout: 10000
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
        const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

        for (const conv of conversations) {
            if (processedInSession.has(conv.id)) continue;

            const full = await intercomRequest('get', `/conversations/${conv.id}`);
            const chat = full.data;

            const isFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const isOldEnough = chat.updated_at < startOfTodayUnix; // Чат обновлен вчера или раньше [cite: 661]

            if (!isFollowUp && isOldEnough) {
                const inOneMinute = Math.floor(Date.now() / 1000) + 60;

                // 1. Устанавливаем снуз на 1 минуту, чтобы он скоро "вылетел" [cite: 365]
                await intercomRequest('post', `/conversations/${conv.id}/snooze`, {
                    admin_id: ADMIN_ID,
                    snoozed_until: inOneMinute
                });

                // 2. Добавляем заметку [cite: 187]
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                processedInSession.add(conv.id);
                log('SUCCESS', `Chat ${conv.id} updated with 1-min snooze.`);
            }
        }
    } catch (e) {
        log('ERR_PRESALE', e.message);
    }
}

// ================= LOGIC: DATA AUDIT (EMAIL & SUB) =================
async function checkClientData(conversationId, contactId) {
    try {
        const res = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = res.data;

        // 1. Email Check
        if (LIST_URL) {
            const { data: list } = await axios.get(LIST_URL);
            const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
            const match = emails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()));
            
            if (match) {
                await intercomRequest('put', `/contacts/${contactId}`, { 
                    custom_attributes: { [CUSTOM_ATTR_NAME]: true } 
                });
                log('MATCH', `Set ${CUSTOM_ATTR_NAME} for ${contactId}`);
            }
        }

        // 2. Subscription Check
        const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
        if (!sub || sub.toString().trim() === '') {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            });
            log('SUB_EMPTY', `Reminder sent to ${conversationId}`);
        }
    } catch (e) {
        log('ERR_DATA_AUDIT', e.message);
    }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    if (req.method === 'HEAD') return res.status(200).send('OK');
    
    const { topic, data } = req.body;
    log('WEBHOOK', `Topic: ${topic}`);

    try {
        const item = data?.item;
        if (!item) return res.status(200).json({ ok: true });

        // Триггер: Агент вышел в онлайн [cite: 662]
        if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
            await processPresale();
        }

        // Триггер: Новое сообщение или чат (проверка Email и Подписки)
        if (topic && topic.startsWith('conversation')) {
            const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;
            if (contactId && item.id) {
                await checkClientData(item.id, contactId);
            }
        }
    } catch (e) {
        log('GLOBAL_ERR', e.message);
    }

    res.status(200).json({ status: 'processed' });
};
