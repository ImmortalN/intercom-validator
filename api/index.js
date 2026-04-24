const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; 
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вышел в онлайн — проверяем snoozed чаты presale 😎';
const INTERCOM_VERSION = '2.14';

// ВАЖНО: В Vercel этот кэш будет сбрасываться при каждом «холодном старте» функции.
// Для 100% надежности лучше использовать БД, но для базовой защиты оставим так.
const processedSubscriptionNotes = new Set();
const processedPresaleNotes = new Set();

function log(tag, message) {
    console.log(`[${tag}] ${new Date().toISOString()} - ${message}`);
}

async function intercomRequest(method, url, data = null) {
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
        timeout: 15000 // Увеличили таймаут для стабильности
    });
}

async function checkUnpaidEmail(contact) {
    if (!contact || (!contact.email && !contact.additional_emails?.length)) return;
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
                        { field: 'assignee_id', operator: '=', value: String(PRESALE_TEAM_ID) }
                    ]
                },
                pagination
            });

            const conversations = searchRes.data.conversations || [];
            const todayStart = new Date().setHours(0, 0, 0, 0);

            for (const conv of conversations) {
                const updatedAt = conv.updated_at * 1000;
                // Пропускаем, если обновлялся сегодня или есть Follow-Up
                if (updatedAt >= todayStart) continue;
                if (conv.custom_attributes?.['Follow-Up'] === true) continue;
                if (processedPresaleNotes.has(conv.id)) continue;

                const snoozeTime = Math.floor(Date.now() / 1000) + 60;
                try {
                    // Используем await, чтобы Vercel не убил процесс раньше времени
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'snoozed', admin_id: ADMIN_ID, snoozed_until: snoozeTime
                    });
                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'note', admin_id: ADMIN_ID, body: PRESALE_NOTE_TEXT
                    });
                    processedPresaleNotes.add(conv.id);
                    log('PRESALE_ACTION', `Chat ${conv.id} resnoozed for 1 min.`);
                } catch (e) { log('PRESALE_ERR', e.message); }
            }
            pagination = searchRes.data.pages?.next ? { per_page: 15, starting_after: searchRes.data.pages.next.starting_after } : null;
        } while (pagination);
    } catch (err) { log('PRESALE_SEARCH_FATAL', err.message); }
}

// === WEBHOOK ENDPOINT ===
app.post('/api/validator', async (req, res) => { // Путь для Vercel
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;

    if (!item) return res.status(200).send('OK');

    try {
        // Логика 1: Проверка Email
        if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
            const contactId = item.contacts?.contacts[0]?.id || item.source?.author?.id;
            if (contactId) {
                const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
                await checkUnpaidEmail(contactRes.data);
            }
        }

        // Логика 2: Проверка Subscription
        if (topic === 'conversation.admin.assigned') {
            const hasSubscription = item.custom_attributes?.subscription;
            const assigneeType = item.assignee?.type;

            if (assigneeType === 'admin' && !hasSubscription && !processedSubscriptionNotes.has(item.id)) {
                await intercomRequest('post', `/conversations/${item.id}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Please fill subscription 😇'
                });
                processedSubscriptionNotes.add(item.id);
                log('SUBSCRIPTION', `Note sent for conversation ${item.id}`);
            }
        }

        // Логика 3: Триггер Presale (Away Mode)
        if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
            log('TRIGGER', `Admin ${item.id} back online.`);
            // ОЧЕНЬ ВАЖНО: Ждем завершения поиска перед ответом
            await handlePresale();
        }

        res.status(200).send('OK');
    } catch (error) {
        log('GLOBAL_ERROR', error.message);
        res.status(200).send('Error but OK'); // Все равно шлем 200, чтобы Intercom не спамил ретраями
    }
});

module.exports = app; // Экспорт для Vercel
