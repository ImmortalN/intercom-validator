const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === КОНФІГУРАЦІЯ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; // ID для системних нотаток (Subscription)
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо чати пресейлу 😎';
const INTERCOM_VERSION = '2.14';
const CUSTOM_ATTR_NAME = 'Unpaid Custom';

// Кешування для запобігання дублюванню нотаток в одному чаті під час сесії
const processedSubscriptionConversations = new Set();

// === ДОПОМІЖНІ ФУНКЦІЇ ===
function log(tag, message, data = '') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${tag}] ${message}`, data);
}

// === ЛОГІКА 1 та 2: UNPAID ТА SUBSCRIPTION ===
async function processClientData(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts[0]?.id || item.user?.id;

    if (!contactId) {
        log('SKIP', `Не знайдено ID клієнта в чаті ${conversationId}`);
        return;
    }

    try {
        log('FETCH', `Отримання даних клієнта ${contactId}...`);
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: { 
                'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                'Accept': 'application/json', 
                'Intercom-Version': INTERCOM_VERSION 
            }
        });

        const contact = contactRes.data;
        const email = contact.email;
        const purchaseEmail = contact.custom_attributes?.['Purchase Email'];
        const subscription = contact.custom_attributes?.['subscription'];

        // --- Логіка 1: Перевірка Unpaid ---
        if (email || purchaseEmail) {
            log('UNPAID-CHECK', `Перевірка списку для ${email || purchaseEmail}`);
            const listRes = await axios.get(LIST_URL);
            const unpaidList = listRes.data;

            const isUnpaid = (email && unpaidList.includes(email)) || 
                             (purchaseEmail && unpaidList.includes(purchaseEmail));

            if (isUnpaid) {
                log('UNPAID-MATCH', `Клієнт у списку! Оновлюю атрибут ${CUSTOM_ATTR_NAME}...`);
                await axios.put(`https://api.intercom.io/contacts/${contactId}`, 
                    { custom_attributes: { [CUSTOM_ATTR_NAME]: true } },
                    { headers: { 
                        'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                        'Content-Type': 'application/json', 
                        'Intercom-Version': INTERCOM_VERSION 
                    }
                });
                log('SUCCESS', `Атрибут Unpaid встановлено для ${contactId}`);
            }
        }

        // --- Логіка 2: Перевірка поля Subscription ---
        if (!subscription || subscription.trim() === '') {
            if (!processedSubscriptionConversations.has(conversationId)) {
                log('SUBS-EMPTY', `Поле subscription порожнє в чаті ${conversationId}. Надсилаю нотатку...`);
                
                await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    type: 'admin',
                    admin_id: ADMIN_ID,
                    body: 'Please fill subscription 😇'
                }, { 
                    headers: { 
                        'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                        'Intercom-Version': INTERCOM_VERSION 
                    } 
                });
                
                processedSubscriptionConversations.add(conversationId);
                log('SUCCESS', `Нотатка про підписку додана в чат ${conversationId}`);
            }
        }

    } catch (err) {
        log('ERROR', `Помилка обробки даних клієнта: ${err.message}`);
    }
}

// === ЛОГІКА 3: PRESALE TRIGGER (AWAY MODE) ===
async function runPresaleCheck(adminId) {
    log('PRESALE-START', `Запуск перевірки заснужених чатів для адміна ${adminId}...`);
    let count = 0;

    try {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const startOfTodayUnix = Math.floor(startOfToday.getTime() / 1000);

        // Шукаємо заснужені чати пресейл команди
        const searchRes = await axios.post('https://api.intercom.io/conversations/search', {
            query: {
                operator: 'AND',
                value: [
                    { field: 'state', operator: '=', value: 'snoozed' },
                    { field: 'assignee_id', operator: '=', value: PRESALE_TEAM_ID }
                ]
            }
        }, {
            headers: { 
                'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                'Intercom-Version': INTERCOM_VERSION, 
                'Content-Type': 'application/json' 
            }
        });

        const conversations = searchRes.data.conversations || [];
        log('PRESALE-INFO', `Знайдено заснужених чатів: ${conversations.length}`);

        for (const conv of conversations) {
            // Перевірка, чи чат не оновлювався сьогодні
            if (conv.updated_at < startOfTodayUnix) {
                log('PRESALE-ACTION', `Обробка чату ${conv.id} (останнє оновлення: ${conv.updated_at})`);
                
                await axios.post(`https://api.intercom.io/conversations/${conv.id}/reply`, {
                    message_type: 'note',
                    type: 'admin',
                    admin_id: adminId,
                    body: PRESALE_NOTE_TEXT
                }, { 
                    headers: { 
                        'Authorization': `Bearer ${INTERCOM_TOKEN}`, 
                        'Intercom-Version': INTERCOM_VERSION 
                    } 
                });
                count++;
            } else {
                log('PRESALE-SKIP', `Чат ${conv.id} оновлювався сьогодні, пропускаємо.`);
            }
        }
    } catch (err) {
        log('PRESALE-ERROR', `Критична помилка пресейл-логіки: ${err.message}`);
    }
    return count;
}

// === ГОЛОВНИЙ ОБРОБНИК WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;

    if (!item) {
        return res.status(200).json({ ok: true, status: 'no_data' });
    }

    log('WEBHOOK-RCV', `Отримано топік: ${topic}`);

    // Трігер для Unpaid та Subscription
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        processClientData(item);
    }

    // Трігер для Presale (Away Mode)
    if (topic === 'admin.away_mode_updated') {
        const adminId = item.id; // Для цього топіку ID адміна знаходиться в item.id
        const isAway = item.away_mode_enabled;

        log('STATUS-CHANGE', `Адмін ${adminId} змінив статус. Away Mode: ${isAway}`);

        if (isAway === false && adminId) {
            const processedCount = await runPresaleCheck(adminId);
            log('PRESALE-COMPLETE', `Перевірку закінчено. Оброблено чатів: ${processedCount}`);
        }
    }

    res.status(200).json({ ok: true });
});

// Підтримка HEAD запитів для перевірки Intercom
app.head('/validate-email', (req, res) => res.status(200).end());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`--- СЕРВЕР ЗАПУЩЕНО НА ПОРТУ ${PORT} ---`);
    console.log(`Активні логіки: Unpaid, Subscription, Presale Check`);
});
