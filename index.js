const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вышел в онлайн — проверяем snoozed чаты presale 😎';
const INTERCOM_VERSION = '2.14';

// Кэш для защиты от дублей ноутов (сбрасывается при рестарте сервера)
const processedSubscriptionNotes = new Set();
const processedPresaleNotes = new Set();

function log(tag, message) {
    console.log(`[${tag}] ${new Date().toISOString()} - ${message}`);
}

async function intercomRequest(method, url, data = null, timeout = 10000) {
    return axios({
        method,
        url: `https://api.intercom.io${url}`,
        headers: {
            'Authorization': `Bearer ${INTERCOM_TOKEN}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Intercom-Version': INTERCOM_VERSION
        },
        data,
        timeout
    });
}

// 1. Проверка Email по списку (Unpaid Custom)
async function checkUnpaidEmail(contact) {
    if (!contact.email && !contact.additional_emails?.length) return;
    try {
        const listRes = await axios.get(LIST_URL);
        const unpaidEmails = listRes.data;
        const emailsToCheck = [contact.email, ...(contact.additional_emails || [])].filter(Boolean);
        const isUnpaid = emailsToCheck.some(email => unpaidEmails.includes(email));
        
        if (isUnpaid) {
            await intercomRequest('put', `/contacts/${contact.id}`, {
                custom_attributes: { 'Unpaid Custom': true }
            });
            log('UNPAID', `Attribute set for contact ${contact.id}`);
        }
    } catch (err) {
        log('UNPAID_ERROR', err.message);
    }
}

// 2. Логика Presale (обработка чатов)
async function handlePresale() {
    log('PRESALE', 'Starting search for snoozed chats...');
    let pagination = { per_page: 15 };
    try {
        do {
            const searchRes = await intercomRequest('post', '/conversations/search', {
                query: {
                    operator: 'AND',
                    value: [
                        { field: 'state', operator: '=', value: 'snoozed' },
                        { field: 'assignee_id', operator: '=', value: PRESALE_TEAM_ID }
                    ]
                },
                pagination
            }, 25000);

            const conversations = searchRes.data.conversations || [];
            const todayStart = new Date().setHours(0, 0, 0, 0);

            for (const conv of conversations) {
                const updatedAt = conv.updated_at * 1000;
                if (updatedAt >= todayStart) continue;
                if (conv.custom_attributes && conv.custom_attributes['Follow-Up'] === true) continue;
                if (processedPresaleNotes.has(conv.id)) continue;

                const snoozeTime = Math.floor(Date.now() / 1000) + 60;
                try {
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'snoozed', admin_id: ADMIN_ID, snoozed_until: snoozeTime
                    });
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'note', admin_id: ADMIN_ID, body: PRESALE_NOTE_TEXT
                    });
                    processedPresaleNotes.add(conv.id);
                } catch (e) { log('PRESALE_ERR', e.message); }
            }
            pagination = searchRes.data.pages?.next ? { per_page: 15, starting_after: searchRes.data.pages.next.starting_after } : null;
        } while (pagination);
    } catch (err) { log('PRESALE_SEARCH_FATAL', err.message); }
}

// === WEBHOOK ENDPOINT ===
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;

    if (!item) return res.status(200).send('OK');

    // Логика 1: Проверка Email (на сообщения клиента)
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts[0]?.id || item.source?.author?.id;
        if (contactId) {
            intercomRequest('get', `/contacts/${contactId}`).then(res => checkUnpaidEmail(res.data));
        }
    }

    // Логика 2: Проверка Subscription (срабатывает при назначении на агента)
    if (topic === 'conversation.admin.assigned') {
        const hasSubscription = item.custom_attributes?.subscription;
        const assigneeType = item.assignee?.type; // admin или team

        // Проверяем: назначен на живого админа, подписки нет, ноут еще не слали
        if (assigneeType === 'admin' && !hasSubscription && !processedSubscriptionNotes.has(item.id)) {
            intercomRequest('post', `/conversations/${item.id}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇'
            }).then(() => {
                processedSubscriptionNotes.add(item.id);
                log('SUBSCRIPTION', `Note sent for conversation ${item.id}`);
            }).catch(err => log('SUBSCRIPTION_ERR', err.message));
        }
    }

    // Логика 3: Триггер Presale (Away Mode)
    if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
        log('TRIGGER', `Admin ${item.id} back online.`);
        handlePresale();
    }

    res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log('SERVER', `Running on port ${PORT}`));
