const axios = require('axios');

// === КОНФИГУРАЦИЯ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const LIST_URL = process.env.LIST_URL;
const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_UNPAID = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const SUBSCRIPTION_ATTR = 'subscription';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати presale 😎';

const lastProcessedDate = new Map();
const processedSubNotes = new Set(); 

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(tag, message, data = '') {
    console.log(`[${new Date().toISOString()}] [${tag}] ${message}`, data ? JSON.stringify(data) : '');
}

async function intercomRequest(method, url, data, customTimeout = 20000) {
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
}

// ================= 1. ЛОГИКА "UNPAID & SUBSCRIPTION" =================
async function handleUnpaidAndSubscription(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id;
    const assigneeType = item.assignee?.type; 

    if (!contactId) return;

    try {
        const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
        const contact = contactRes.data;
        
        // --- Проверка Unpaid ---
        const email = contact.email;
        const purchaseEmail = contact.custom_attributes?.['Purchase Email'];

        if (LIST_URL && (email || purchaseEmail)) {
            try {
                const listRes = await axios.get(LIST_URL);
                const emailsInList = listRes.data.map(e => String(e).toLowerCase());
                const isMatch = (email && emailsInList.includes(email.toLowerCase())) || 
                                (purchaseEmail && emailsInList.includes(purchaseEmail.toLowerCase()));
                
                if (isMatch) {
                    await intercomRequest('put', `/contacts/${contactId}`, {
                        custom_attributes: { [CUSTOM_ATTR_UNPAID]: true }
                    });
                    log('UNPAID', `Contact ${contactId} marked as Unpaid.`);
                }
            } catch (e) { log('LIST_ERR', 'Error fetching external list'); }
        }

        // --- Проверка Subscription ---
        const subValue = contact.custom_attributes?.[SUBSCRIPTION_ATTR];
        if (assigneeType === 'admin' && (!subValue || subValue === '') && !processedSubNotes.has(conversationId)) {
            await intercomRequest('post', `/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            });
            processedSubNotes.add(conversationId);
            log('SUBSCRIPTION', `Note sent to chat ${conversationId}`);
        }
    } catch (err) {
        log('CHECK_ERR', err.message);
    }
}

// ================= 2 & 3. ЛОГИКА PRESALE =================
async function processPresale(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (lastProcessedDate.get(adminId) === todayStr) {
        log('SKIP', `Admin ${adminId} already processed today.`);
        return;
    }

    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    let startingAfter = null;

    log('PRESALE', `Starting scan for Admin ${adminId}. Team: ${PRESALE_TEAM_ID}`);

    try {
        do {
            // ИСПРАВЛЕНО: используем team_assignee_id вместо assignee_id
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { field: "snoozed_until", operator: "<", value: startOfTodayUnix }
                    ]
                },
                pagination: { per_page: 20 }
            };

            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            log('DEBUG', 'Search query (Corrected):', searchBody);

            const searchRes = await intercomRequest('post', '/conversations/search', searchBody);
            const chats = searchRes.data.conversations || [];
            
            log('DEBUG', `Found ${chats.length} chats to process.`);

            for (const conv of chats) {
                try {
                    // Получаем полный объект чата для проверки Follow-Up
                    const chatRes = await intercomRequest('get', `/conversations/${conv.id}`);
                    const chat = chatRes.data;

                    if (chat.custom_attributes?.[FOLLOW_UP_ATTR] === true) {
                        log('SKIP', `Chat ${conv.id} ignored (Follow-Up is true).`);
                        continue;
                    }

                    const oneMinuteFromNow = Math.floor(Date.now() / 1000) + 60;
                    
                    // 1. Метод 1-минутный Snooze
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'snoozed', 
                        admin_id: ADMIN_ID, 
                        snoozed_until: oneMinuteFromNow
                    });

                    // 2. Отправка заметки
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'note', 
                        admin_id: ADMIN_ID, 
                        body: PRESALE_NOTE_TEXT
                    });

                    log('ACTION', `Chat ${conv.id} scheduled to wake up in 60s.`);
                    await sleep(500); // Небольшая пауза между чатами
                } catch (err) {
                    log('CHAT_ERR', `Conv ${conv.id}: ${err.message}`);
                }
            }
            startingAfter = searchRes.data.pages?.next?.starting_after;
        } while (startingAfter);

        lastProcessedDate.set(adminId, todayStr);
        log('SUCCESS', 'Presale scan finished.');
    } catch (e) {
        log('SEARCH_FATAL', e.response?.data || e.message);
    }
}

// ================= ВЕБХУК ХЕНДЛЕР =================
module.exports = async (req, res) => {
    if (req.method === 'HEAD') return res.status(200).send('OK');

    const body = req.body;
    if (!body || !body.topic) return res.status(200).json({ ok: true });

    res.status(200).json({ ok: true });

    const topic = body.topic;
    const item = body.data?.item;

    try {
        // Unpaid & Subscription срабатывает на сообщения и ответы админов
        if (topic.includes('conversation.user') || topic === 'conversation.admin.replied') {
            handleUnpaidAndSubscription(item).catch(e => log('ASYNC_MSG_ERR', e.message));
        }

        // Presale Trigger срабатывает при возвращении админа в онлайн
        if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
            log('WEBHOOK', `Admin ${item.id} BACK online.`);
            processPresale(item.id).catch(e => log('ASYNC_PRESALE_ERR', e.message));
        }
    } catch (e) {
        log('HANDLER_ERR', e.message);
    }
};
