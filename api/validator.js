const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const INTERCOM_VERSION = '2.14';

const sleep = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms));

async function intercomRequest(method, url, data) {
    await sleep(); 
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

// Эндпоинт для вебхука
app.post('/validate-email', async (req, res) => {
    console.log('Webhook received:', req.body.topic);
    
    const { topic, data } = req.body;
    if (!data?.item) return res.status(200).send('No data');

    const item = data.item;

    // Важно: в Serverless мы не можем долго ждать, 
    // поэтому запускаем логику и стараемся завершить её быстрее
    try {
        if (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false) {
            // Логика Presale (обработка чатов)
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

                if (chat.custom_attributes?.['Follow-Up'] !== true && chat.updated_at < startOfTodayUnix) {
                    const inOneMinute = Math.floor(Date.now() / 1000) + 60;
                    
                    // ПРАВИЛЬНЫЙ SNOOZE
                    await intercomRequest('post', `/conversations/${conv.id}/snooze`, {
                        admin_id: ADMIN_ID,
                        snoozed_until: inOneMinute
                    });

                    await intercomRequest('post', `/conversations/${conv.id}/reply`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        body: process.env.PRESALE_NOTE_TEXT || 'Агент в онлайне — проверяем чат'
                    });
                }
            }
        }

        if (topic && topic.includes('conversation')) {
            const contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;
            if (contactId) {
                // Логика проверки Email и Subscription
                const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
                const contact = contactRes.data;

                // Проверка Subscription
                const sub = contact.custom_attributes?.Subscription || contact.custom_attributes?.subscription;
                if (!sub) {
                    await intercomRequest('post', `/conversations/${item.id}/reply`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        body: 'Please fill subscription 😇'
                    });
                }
            }
        }
    } catch (e) {
        console.error('Error:', e.message);
    }

    // Всегда отвечаем 200 быстро, чтобы Intercom не считал запрос упавшим
    res.status(200).send('OK');
});

// Для локальной разработки и Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Server on 3000'));
}

module.exports = app;
