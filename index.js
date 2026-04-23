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
const FOLLOW_UP_ATTR = 'Follow-Up'; // Проверь, чтобы в Intercom имя было точно таким
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';

const processedInSession = new Set();

function log(tag, message) {
    console.log(`[${tag}] ${new Date().toLocaleTimeString()}:`, message);
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
        }
    });
}

// ================= LOGIC: PRESALE ENGINE =================
async function processPresale() {
    log('PRESALE', 'Starting scan...');
    try {
        // Точь-в-точь как в твоем Postman
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
        log('PRESALE', `Found ${conversations.length} total snoozed chats.`);

        const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

        for (const conv of conversations) {
            if (processedInSession.has(conv.id)) continue;

            // В результатах поиска нет всех custom_attributes, запрашиваем детально
            const full = await intercomRequest('get', `/conversations/${conv.id}`);
            const chat = full.data;

            // УСЛОВИЯ:
            // 1. Нет аттрибута Follow-Up (или он false)
            const isFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            // 2. Был изменен ДО сегодняшнего дня (вчера и ранее)
            const isOldEnough = chat.updated_at < startOfTodayUnix;

            if (!isFollowUp && isOldEnough) {
                log('ACTION', `Processing chat ${conv.id}`);

                // Твой метод: Snooze на 1 минуту
                const inOneMinute = Math.floor(Date.now() / 1000) + 60;

                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'snoozed',
                    admin_id: ADMIN_ID,
                    snoozed_until: inOneMinute
                });

                // Отправка ноута
                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });

                processedInSession.add(conv.id);
                log('SUCCESS', `Chat ${conv.id} will wake up in 60s.`);
            } else {
                log('SKIP', `Chat ${conv.id} (FollowUp: ${isFollowUp}, Old: ${isOldEnough})`);
            }
        }
    } catch (e) {
        log('ERR_PRESALE', e.response?.data || e.message);
    }
}

// ================= LOGIC: DATA CHECK =================
async function checkClientData(conversationId, contactId) {
    try {
        const res = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = res.data;

        // Email Check
        if (LIST_URL) {
            const { data: list } = await axios.get(LIST_URL);
            const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
            if (emails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()))) {
                await intercomRequest('put', `/contacts/${contactId}`, { custom_attributes: { [CUSTOM_ATTR_NAME]: true } });
            }
        }

        // Sub Check
        const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
        if (!sub) {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            });
        }
    } catch (e) {
        log('ERR_DATA', e.message);
    }
}

// ================= WEBHOOK =================
app.post('/validate-email', async (req, res) => {
    const { topic, data } = req.body;
    if (!data?.item) return res.sendStatus(200);

    const item = data.item;

    try {
        // ТРИГГЕР 1: Изменение статуса агента
        if (topic === 'admin.away_mode_updated') {
            log('EVENT', `Away mode changed. Enabled: ${item.away_mode_enabled}`);
            if (item.away_mode_enabled === false) {
                await processPresale();
            }
        }

        // ТРИГГЕР 2: Работа с данными (создание чата или ответ)
        if (topic.includes('conversation')) {
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

app.listen(process.env.PORT || 3000, () => log('SYSTEM', 'Engine started. Looking for Presale chats...'));
