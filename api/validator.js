const axios = require('axios');

// === ENV & CONSTANTS ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';
const SUB_REMINDER_TEXT = 'Please fill subscription 😇';

// Хранилище для защиты от повторных запусков за один день (в рамках жизни сервера)
const lastProcessedDate = new Map(); // adminId -> YYYY-MM-DD

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

// ================= LOGIC: DATA AUDIT (EMAIL & SUB) =================
async function checkClientData(conversationId, contactId) {
    try {
        log('AUDIT', `Checking data for conv ${conversationId}`);
        
        const convRes = await intercomRequest('get', `/conversations/${conversationId}`);
        const conversation = convRes.data;

        // Проверяем, нет ли уже заметки про подписку
        const hasAlreadyNotified = conversation.conversation_parts?.conversation_parts.some(
            part => part.body && part.body.includes(SUB_REMINDER_TEXT)
        );

        if (hasAlreadyNotified) {
            log('AUDIT', 'Subscription note already exists, skipping.');
            return;
        }

        const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = contactRes.data;

        // 1. Проверка Email (Unpaid Custom)
        if (LIST_URL) {
            try {
                const { data: list } = await axios.get(LIST_URL);
                const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
                const match = emails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()));
                
                if (match) {
                    await intercomRequest('put', `/contacts/${contactId}`, { 
                        custom_attributes: { [CUSTOM_ATTR_NAME]: true } 
                    });
                    log('AUDIT', `Marked ${contactId} as Unpaid`);
                }
            } catch (err) { log('ERR_LIST', err.message); }
        }

        // 2. Проверка подписки
        const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
        if (!sub || sub.toString().trim() === '') {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: SUB_REMINDER_TEXT
            });
            log('AUDIT', `Sent reminder to ${conversationId}`);
        }
    } catch (e) {
        log('ERR_AUDIT', e.message);
    }
}

// ================= LOGIC: PRESALE ENGINE =================
async function processPresale(adminId) {
    // Защита: запускаем только 1 раз в календарный день для этого админа
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('PRESALE', `Admin ${adminId} already processed today. Skipping.`);
        return;
    }

    log('PRESALE', `Starting scan for Admin ${adminId}...`);
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
            const full = await intercomRequest('get', `/conversations/${conv.id}`);
            const chat = full.data;
            
            const isFollowUp = chat.custom_attributes?.[FOLLOW_UP_ATTR] === true;
            const isOldEnough = chat.updated_at < startOfTodayUnix;

            if (!isFollowUp && isOldEnough) {
                // Метод 1-минутного снуза
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
                
                log('ACTION', `Updated snooze and sent note for chat ${conv.id}`);
            }
        }
        
        // Запоминаем, что на сегодня закончили
        lastProcessedDate.set(adminId, todayStr);
        
    } catch (e) { log('ERR_PRESALE', e.message); }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    // Обработка HEAD запросов от Intercom
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;

    if (!item) return res.status(200).json({ ok: true });

    try {
        // 1. Логика AWAY MODE (Presale Trigger)
        if (topic === 'admin.away_mode_updated') {
            const adminId = item.id;
            const isAway = item.away_mode_enabled;

            console.log(`[WEBHOOK] Статус агента змінено: ID ${adminId}, Away Mode: ${isAway}`);

            if (isAway === false) {
                console.log(`[ACTION] Агент ${adminId} повернувся! Запускаю перевірку Presale чатів...`);
                await processPresale(adminId);
            }
        }

        // 2. Логика ASSIGNED (Unpaid & Subscription)
        // Срабатывает, когда чат передается на агента или команду
        if (topic === 'conversation.admin.assigned') {
            const contactId = item.contacts?.contacts?.[0]?.id;
            const conversationId = item.id;

            if (contactId && conversationId) {
                await checkClientData(conversationId, contactId);
            }
        }

    } catch (e) {
        log('GLOBAL_ERR', e.message);
    }

    res.status(200).json({ ok: true });
};
