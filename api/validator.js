const axios = require('axios');

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';
const SUB_REMINDER_TEXT = 'Please fill subscription 😇';

function log(tag, message, data = '') {
    console.log(`[${tag}] ${message}`, data ? JSON.stringify(data) : '');
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
        log('PRESALE', `Search found ${conversations.length} chats in team ${PRESALE_TEAM_ID}`);

        const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

        for (const conv of conversations) {
            const full = await intercomRequest('get', `/conversations/${conv.id}`);
            const chat = full.data;

            const isFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const isOldEnough = chat.updated_at < startOfTodayUnix;

            if (!isFollowUp && isOldEnough) {
                log('ACTION', `Un-snoozing chat ${conv.id}`);
                const inOneMinute = Math.floor(Date.now() / 1000) + 60;

                await intercomRequest('post', `/conversations/${conv.id}/snooze`, {
                    admin_id: ADMIN_ID,
                    snoozed_until: inOneMinute
                });

                await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: PRESALE_NOTE_TEXT
                });
            } else {
                log('SKIP', `Chat ${conv.id} - FollowUp: ${isFollowUp}, OldEnough: ${isOldEnough}`);
            }
        }
    } catch (e) {
        log('ERR_PRESALE', e.message, e.response?.data);
    }
}

// ================= LOGIC: DATA AUDIT (EMAIL & SUB) =================
async function checkClientData(conversationId, contactId) {
    try {
        // Получаем чат, чтобы проверить последние ноуты
        const convRes = await intercomRequest('get', `/conversations/${conversationId}`);
        const conversation = convRes.data;
        
        // Проверяем, не писали ли мы уже этот ноут
        const hasAlreadyNotified = conversation.conversation_parts?.conversation_parts.some(
            part => part.body && part.body.includes(SUB_REMINDER_TEXT)
        );

        if (hasAlreadyNotified) {
            log('SUB_CHECK', 'Subscription note already exists, skipping.');
        } else {
            const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
            const contact = contactRes.data;

            // 1. Email Check
            if (LIST_URL) {
                try {
                    const { data: list } = await axios.get(LIST_URL);
                    const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
                    const match = emails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()));
                    if (match) {
                        await intercomRequest('put', `/contacts/${contactId}`, { 
                            custom_attributes: { [CUSTOM_ATTR_NAME]: true } 
                        });
                    }
                } catch (err) { log('ERR_LIST', err.message); }
            }

            // 2. Subscription Check (только если еще не уведомляли)
            const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
            if (!sub || sub.toString().trim() === '') {
                await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: SUB_REMINDER_TEXT
                });
                log('SUB_EMPTY', `Sent reminder to ${conversationId}`);
            }
        }
    } catch (e) {
        log('ERR_DATA_AUDIT', e.message);
    }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    const { topic, data } = req.body;
    if (!data?.item) return res.status(200).send('OK');

    try {
        if (topic === 'admin.away_mode_updated' && data.item.away_mode_enabled === false) {
            await processPresale();
        }

        if (topic && topic.startsWith('conversation')) {
            const contactId = data.item.contacts?.contacts?.[0]?.id || data.item.author?.id;
            if (contactId && data.item.id) {
                await checkClientData(data.item.id, contactId);
            }
        }
    } catch (e) {
        log('GLOBAL_ERR', e.message);
    }
    res.status(200).json({ ok: true });
};
