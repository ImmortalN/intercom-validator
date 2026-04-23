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

const lastProcessedDate = new Map();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(tag, message, data = '') {
    console.log(`[${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

// Универсальный запрос с обработкой Rate Limit (429)
async function intercomRequest(method, url, data, customTimeout = 5000) {
    try {
        return await axios({
            method,
            url: `https://api.intercom.io${url}`,
            data,
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Intercom-Version': INTERCOM_VERSION,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: customTimeout
        });
    } catch (error) {
        if (error.response?.status === 429) {
            log('RATE_LIMIT', 'Too many requests, sleeping 2 seconds...');
            await sleep(2000);
            return intercomRequest(method, url, data, customTimeout); // Повтор
        }
        throw error;
    }
}

// ================= LOGIC: DATA AUDIT =================
async function checkClientData(conversationId, contactId) {
    try {
        // Уменьшаем таймаут для аудита, чтобы вебхук не висел
        const convRes = await intercomRequest('get', `/conversations/${conversationId}`, null, 3000);
        const conversation = convRes.data;

        const hasNote = conversation.conversation_parts?.conversation_parts.some(
            part => part.body && part.body.includes(SUB_REMINDER_TEXT)
        );
        if (hasNote) return;

        const contactRes = await intercomRequest('get', `/contacts/${contactId}`, null, 3000);
        const contact = contactRes.data;

        if (LIST_URL) {
            const { data: list } = await axios.get(LIST_URL, { timeout: 2000 }).catch(() => ({ data: [] }));
            const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
            const match = emails.some(e => list.some(l => l?.toLowerCase().trim() === e.toLowerCase().trim()));
            if (match) {
                await intercomRequest('put', `/contacts/${contactId}`, { custom_attributes: { [CUSTOM_ATTR_NAME]: true } });
            }
        }

        const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
        if (!sub || sub.toString().trim() === '') {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note', admin_id: ADMIN_ID, body: SUB_REMINDER_TEXT
            });
        }
    } catch (e) { log('AUDIT_ERR', e.message); }
}

// ================= LOGIC: PRESALE ENGINE (PAGINATED) =================
async function processPresale(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) return;

    log('PRESALE', `Starting paginated scan for Admin ${adminId}`);
    
    let pagination = { per_page: 50 };
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    try {
        while (pagination) {
            const searchRes = await intercomRequest('post', '/conversations/search', {
                query: {
                    operator: 'AND',
                    value: [
                        { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
                        { field: 'state', operator: '=', value: 'snoozed' }
                    ]
                },
                pagination: pagination
            }, 10000);

            const conversations = searchRes.data.conversations || [];
            log('PRESALE', `Processing page of ${conversations.length} chats...`);

            for (const conv of conversations) {
                try {
                    await sleep(300); 
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`, null, 5000);
                    const chat = chatRes.data;
                    
                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] !== true && chat.updated_at < startOfTodayUnix) {
                        const inOneMinute = Math.floor(Date.now() / 1000) + 60;
                        
                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'snoozed', admin_id: ADMIN_ID, snoozed_until: inOneMinute
                        });

                        await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                            message_type: 'note', admin_id: ADMIN_ID, body: PRESALE_NOTE_TEXT
                        });
                        log('ACTION', `Un-snoozed chat ${conv.id}`);
                    }
                } catch (err) {
                    if (err.response?.status !== 404) log('CHAT_ERR', err.message);
                }
            }

            // Проверка: есть ли следующая страница?
            if (searchRes.data.pages?.next) {
                pagination = { 
                    per_page: 50, 
                    starting_after: searchRes.data.pages.next.starting_after 
                };
                log('PRESALE', 'Moving to next page...');
            } else {
                pagination = null;
            }
        }
        
        lastProcessedDate.set(adminId, todayStr);
        log('PRESALE', 'All pages processed.');
        
    } catch (e) { log('SEARCH_FATAL', e.message); }
}

// ================= VERCEL HANDLER =================
module.exports = async (req, res) => {
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const { topic, data } = req.body;
    if (!data?.item) return res.status(200).json({ ok: true });

    // 1. Мгновенно отвечаем Intercom, чтобы уложиться в 500мс
    res.status(200).json({ ok: true });

    // 2. Выполняем логику после отправки ответа
    try {
        if (topic === 'admin.away_mode_updated' && data.item.away_mode_enabled === false) {
            processPresale(data.item.id).catch(e => log('ASYNC_PRESALE_ERR', e.message));
        }

        if (topic === 'conversation.admin.assigned') {
            const contactId = data.item.contacts?.contacts?.[0]?.id;
            if (contactId) {
                checkClientData(data.item.id, contactId).catch(e => log('ASYNC_AUDIT_ERR', e.message));
            }
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
