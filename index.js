const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const DELAY_MS = 30000;
const PRESALE_FOLLOWUP_TAG_ID = '13404165';
const FOLLOW_UP_ATTR = 'Follow-Up';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// === НОВОЕ: КОНТРОЛЬ "СЛЕДУЮЩИЙ ДЕНЬ" ===
// Теперь ноут появляется ТОЛЬКО 1 раз в день (при первом триггере away_mode_updated / logged_in)
// Это решает проблему: даже если агент выключает away mode несколько раз за день — ноут не дублируется.
// Работает как "следующий день" по календарю (10.04 → 11.04). Reassign replies не имеет вебхука, поэтому этот workaround идеально заменяет твою идею.
const lastProcessedDay = new Map();

const processedConversations = new Set();               // можно оставить, но уже не используется для unpaid
const processedSubscriptionConversations = new Set();
const processedTransferConversations = new Set();

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID) {
    console.error('ОШИБКА: INTERCOM_TOKEN, LIST_URL или ADMIN_ID не заданы!');
    process.exit(1);
}

console.log('Webhook запущен (с проверкой следующего дня для presale ноутов)');

function log(...args) {
    if (DEBUG) console.log(...args);
}

// === ФУНКЦИЯ ОБНОВЛЕНИЯ АТРИБУТОВ КОНТАКТУ ===
async function updateContactAttribute(contactId, attributes) {
    if (!contactId || !attributes) return;
    try {
        await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
            custom_attributes: attributes
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 8000
        });
        log(`[ATTR UPDATE] Контакт ${contactId} оновлено:`, attributes);
    } catch (error) {
        console.error(`[ATTR UPDATE FAIL] Контакт ${contactId}:`, error.response?.data || error.message);
    }
}

// === ДОБАВЛЕНИЕ ЗАМЕТКИ ===
async function addNoteWithDelay(conversationId, text, delay = DELAY_MS, adminId = ADMIN_ID) {
    if (!conversationId) return;
    setTimeout(async () => {
        try {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: adminId,
                body: text
            }, {
                headers: {
                    'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Intercom-Version': INTERCOM_VERSION
                },
                timeout: 6000
            });
            log(`[NOTE] від ${adminId}: "${text.slice(0, 60)}..." → ${conversationId}`);
        } catch (error) {
            console.error(`[NOTE FAIL] conv ${conversationId}:`, error.response?.data || error.message);
        }
    }, delay);
}

// === ДОБАВЛЕНИЕ ТЕГА ===
async function addTagToConversation(conversationId, tagId = PRESALE_FOLLOWUP_TAG_ID, adminId = ADMIN_ID) {
    if (!conversationId) return;
    try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/tags`, {
            id: tagId,
            admin_id: adminId
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 8000
        });
        log(`[TAG SUCCESS] ID ${tagId} додано в ${conversationId}`);
    } catch (error) {
        log(`[TAG FAIL] ${conversationId}:`, error.message);
    }
}

// === UNSNOOZE ===
async function unsnoozeConversation(conversationId, adminId = ADMIN_ID) {
    if (!conversationId) return;
    try {
        await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
            message_type: 'open',
            admin_id: adminId
        }, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            },
            timeout: 6000
        });
    } catch (error) {
        console.error(`[UNSNZ FAIL] ${conversationId}:`, error.message);
    }
}

// === ПРОВЕРКА Follow-Up атрибута ===
async function isFollowUpBlocked(conversationId) {
    try {
        const res = await axios.get(`https://api.intercom.io/conversations/${conversationId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });
        return res.data.custom_attributes?.[FOLLOW_UP_ATTR] === true;
    } catch (e) {
        return false;
    }
}

// === PRESALE PROCESSING (с проверкой следующего дня) ===
async function processSnoozedForAdmin(adminId) {
    if (!PRESALE_TEAM_ID || !adminId) return;

    // === НОВАЯ ЛОГИКА: проверяем, что это точно следующий день ===
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (lastProcessedDay.has(adminId) && lastProcessedDay.get(adminId) === today) {
        log(`[PRESALE SKIP] Уже обработано сегодня для админа ${adminId} — ноут НЕ появится повторно (даже при away mode off)`);
        return;
    }
    lastProcessedDay.set(adminId, today);
    log(`[PRESALE START] Первый запуск сегодня для админа ${adminId} — unsnooze + ноут`);

    try {
        let startingAfter = null;
        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "admin_assignee_id", operator: "=", value: adminId },
                        { field: "state", operator: "=", value: "snoozed" }
                    ]
                },
                pagination: { per_page: 50 }
            };
            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const res = await axios.post(`https://api.intercom.io/conversations/search`, searchBody, {
                headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Intercom-Version': INTERCOM_VERSION }
            });

            const convs = res.data.conversations || [];
            for (const conv of convs) {
                if (await isFollowUpBlocked(conv.id)) continue;
                await unsnoozeConversation(conv.id, adminId);
                await addNoteWithDelay(conv.id, PRESALE_NOTE_TEXT, 3000, ADMIN_ID);
                await addTagToConversation(conv.id);
            }
            startingAfter = res.data.pages?.next?.starting_after;
        } while (startingAfter);
    } catch (e) {
        console.error('[PRESALE ERROR]:', e.message);
    }
}

// === ОСНОВНАЯ ПЕРЕВІРКА ТА ОНОВЛЕННЯ (Subscription + Unpaid) ===
async function validateAndSetCustom(contactId, conversationId) {
    if (!contactId || !conversationId) return;
    try {
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: {
                'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                'Accept': 'application/json',
                'Intercom-Version': INTERCOM_VERSION
            }
        });
        const contact = contactRes.data;
        
        const subscription = contact.custom_attributes?.['Subscription'] || '';
        const currentUnpaidStatus = contact.custom_attributes?.[CUSTOM_ATTR_NAME];
        
        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ].filter(Boolean);

        // Перевірка Unpaid Custom — ТІЛЬКИ атрибут, без нотатки
        if (emails.length > 0) {
            const { data: emailList } = await axios.get(LIST_URL, { timeout: 5000 });
           
            if (Array.isArray(emailList)) {
                const isMatch = emails.some(e =>
                    emailList.some(le => (le || '').trim().toLowerCase() === e.trim().toLowerCase())
                );

                if (isMatch && currentUnpaidStatus !== true) {
                    await updateContactAttribute(contactId, { [CUSTOM_ATTR_NAME]: true });
                }
            }
        }

        // Перевірка Subscription — без змін
        if (!subscription.trim() && !processedSubscriptionConversations.has(conversationId)) {
            processedSubscriptionConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
        }

    } catch (e) {
        console.error(`[VALIDATE ERROR] contact ${contactId}:`, e.message);
    }
}

// === WEBHOOK ENDPOINT ===
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;
    if (!item) return res.status(200).json({ ok: true });

    const conversationId = item.id;
    let contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;

    // Сценарії Presale (Away / Login) — теперь с проверкой следующего дня
    if ((topic === 'admin.away_mode_updated' && !item.away_mode_enabled) || topic === 'admin.logged_in') {
        processSnoozedForAdmin(item.id);
        return res.status(200).json({ ok: true });
    }

    // Передача від бота
    if (topic === 'conversation.admin.assigned') {
        const prev = item.previous_assignee || (item.conversation_parts?.conversation_parts?.[0]?.assignee);
        const assignee = item.assignee;
        
        const isTransferFromBot = (prev?.type === 'bot' || (prev?.type === 'admin' && prev.id?.startsWith('bot_'))) && assignee?.type === 'team';
        
        if (isTransferFromBot && !processedTransferConversations.has(conversationId)) {
            processedTransferConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 5000);
        }
        if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
        return res.status(200).json({ ok: true });
    }

    // Клієнт відповів
    if (topic === 'conversation.user.replied') {
        if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
        return res.status(200).json({ ok: true });
    }

    // Загальна перевірка для інших випадків
    if (contactId && conversationId) {
        await validateAndSetCustom(contactId, conversationId);
    }

    res.status(200).json({ ok: true });
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
    console.log('Webhook активний: перевірка Unpaid Custom + Subscription + presale ноут тільки 1 раз на день');
});
