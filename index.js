const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ================= CONFIG =================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; // ID админа, от которого пишутся ноуты
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';

// Чтобы не спамить в один и тот же чат несколько раз за одну смену
const processedInSession = new Set();

function log(tag, message) {
    console.log(`[${tag}] ${new Date().toLocaleTimeString()}:`, message);
}

// Универсальный запрос
async function intercomRequest(method, url, data) {
    return axios({
        method,
        url: `https://api.intercom.io${url}`,
        data,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Intercom-Version': INTERCOM_VERSION,
            'Content-Type': 'application/json'
        }
    });
}

// ================= LOGIC 1: EMAIL & SUB =================
async function checkContactData(conversationId, contactId) {
    try {
        const res = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = res.data;

        // 1. Check Email matching
        if (LIST_URL) {
            const { data: list } = await axios.get(LIST_URL);
            const contactEmails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
            const isUnpaid = contactEmails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()));
            
            if (isUnpaid) {
                await intercomRequest('put', `/contacts/${contactId}`, { custom_attributes: { [CUSTOM_ATTR_NAME]: true } });
                log('EMAIL', `Marked ${contactId} as Unpaid`);
            }
        }

        // 2. Check Subscription
        const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
        if (!sub || sub.toString().trim() === '') {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            });
            log('SUB', `Note sent to ${conversationId}`);
        }
    } catch (e) {
        log('DATA_ERR', e.message);
    }
}

// ================= LOGIC 2 & 3: PRESALE TRIGGER & ACTION =================
async function processPresale() {
    log('PRESALE', 'Starting scan of snoozed chats...');
    try {
        const search = await intercomRequest('post', '/conversations/search', {
            query: {
                operator: 'AND',
                value: [
                    { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                    { field: 'state', operator: '=', value: 'snoozed' }
                ]
            }
        });

        const conversations = search.data.conversations || [];
        log('PRESALE', `Found ${conversations.length} snoozed chats in team.`);

        const startOfToday = new Date().setHours(0, 0, 0, 0) / 1000;

        for (const conv of conversations) {
            if (processedInSession.has(conv.id)) continue;

            // Получаем полные данные чата для проверки атрибутов и даты
            const full = await intercomRequest('get', `/conversations/${conv.id}`);
            const data = full.data;

            const isFollowUp = data.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const wasUpdatedBeforeToday = data.updated_at < startOfToday;

            if (!isFollowUp && wasUpdatedBeforeToday) {
                // 1-minute snooze trick (unsnooze via re-snooze)
                const oneMinUnix = Math.floor(Date.now() / 1000) + 60;

                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'snoozed',
                    admin_id: ADMIN_ID,
                    snoozed_until: oneMinUnix
                });

                // Send Note
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                processedInSession.add(conv.id);
                log('PRESALE', `Chat ${conv.id} resnoozed for 1m + note added`);
            }
        }
    } catch (e) {
        log('PRESALE_ERR', e.message);
    }
}

// ================= WEBHOOK ENDPOINT =================
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;

    if (!item) return res.sendStatus(200);

    log('WEBHOOK', `Received topic: ${topic}`);

    try {
        // Логика AWAY MODE
        if (topic === 'admin.away_mode_updated') {
            const isAway = item.away_mode_enabled;
            log('AWAY_STATUS', `Natalie is now ${isAway ? 'AWAY' : 'ONLINE (Processing chats...)'}`);
            
            if (isAway === false) {
                await processPresale();
            }
        }

        // Логика ЧАТОВ (Email & Subscription)
        if (topic.startsWith('conversation.')) {
            const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;
            if (contactId) {
                await checkContactData(item.id, contactId);
            }
        }
    } catch (e) {
        log('GLOBAL_ERR', e.message);
    }

    res.sendStatus(200);
});

// Очистка сессии раз в сутки
setInterval(() => processedInSession.clear(), 24 * 60 * 60 * 1000);

app.listen(process.env.PORT || 3000, () => log('SYSTEM', 'Final Presale Engine Running'));
