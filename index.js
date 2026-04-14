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
const DELAY_MS = 3000;                    // зменшив, бо тепер не масово
const PRESALE_FOLLOWUP_TAG_ID = '13404165';
const FOLLOW_UP_ATTR = 'Follow-Up';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

// === Один раз на день на адміна ===
const lastProcessedDate = new Map(); // adminId → YYYY-MM-DD

console.log('Webhook запущен — presale ноут ТІЛЬКИ при logged_in + один раз на день');

// === ЛОГІКА "один раз сьогодні" ===
function canShowPresaleNote(adminId) {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (lastProcessedDate.has(adminId) && lastProcessedDate.get(adminId) === todayStr) {
        log(`[PRESALE SKIP] Уже обробляли сьогодні для ${adminId}`);
        return false;
    }

    lastProcessedDate.set(adminId, todayStr);
    log(`[PRESALE ALLOWED] Перший logged_in сьогодні для ${adminId} — запускаємо обробку`);
    return true;
}

function log(...args) {
    if (DEBUG) console.log(...args);
}

// === UNSNOOZE + NOTE + TAG (тільки для конкретного чату) ===
async function processSingleConversation(convId, adminId) {
    if (!convId) return;

    try {
        // 1. Розснузити
        await unsnoozeConversation(convId, adminId);

        // 2. Додати ноут
        await addNoteWithDelay(convId, PRESALE_NOTE_TEXT, 2000, ADMIN_ID);

        // 3. Додати тег
        await addTagToConversation(convId);

        log(`[PRESALE PROCESSED] Чат ${convId} → розснузили + ноут + тег`);
    } catch (e) {
        console.error(`[PRESALE SINGLE FAIL] ${convId}:`, e.message);
    }
}

// === PRESALE PROCESSING — тепер обробляє по одному (не всі одразу) ===
async function processSnoozedForAdmin(adminId) {
    if (!PRESALE_TEAM_ID || !adminId) return;
    if (!canShowPresaleNote(adminId)) return;

    log(`[PRESALE START] Починаємо обробку snoozed чатів presale для ${adminId}`);

    try {
        let startingAfter = null;
        let processedCount = 0;

        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" }
                    ]
                },
                pagination: { per_page: 50 }
            };
            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const res = await axios.post(`https://api.intercom.io/conversations/search`, searchBody, {
                headers: {
                    'Authorization': `Bearer ${INTERCOM_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Intercom-Version': INTERCOM_VERSION
                }
            });

            const convs = res.data.conversations || [];
            log(`[SEARCH] Знайдено ${convs.length} snoozed чатів на цій сторінці`);

            for (const conv of convs) {
                if (await isFollowUpBlocked(conv.id)) {
                    log(`[SKIP] ${conv.id} — Follow-Up заблоковано`);
                    continue;
                }

                // Обробляємо кожен чат окремо
                await processSingleConversation(conv.id, adminId);
                processedCount++;

                // Невелика затримка між чатами, щоб Intercom не блокував
                await new Promise(r => setTimeout(r, 800));
            }

            startingAfter = res.data.pages?.next?.starting_after;
        } while (startingAfter);

        log(`[PRESALE FINISH] Усього оброблено чатів: ${processedCount}`);

    } catch (e) {
        console.error('[PRESALE ERROR]:', e.response?.data || e.message);
    }
}

// === ДОПОМІЖНІ ФУНКЦІЇ (без змін) ===
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
            log(`[NOTE] "${text.slice(0, 60)}..." → ${conversationId}`);
        } catch (error) {
            console.error(`[NOTE FAIL] ${conversationId}:`, error.message);
        }
    }, delay);
}

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
    } catch (error) {
        log(`[TAG FAIL] ${conversationId}:`, error.message);
    }
}

// === validateAndSetCustom (без змін) ===
const processedSubscriptionConversations = new Set();
const processedTransferConversations = new Set();

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

        if (!subscription.trim() && !processedSubscriptionConversations.has(conversationId)) {
            processedSubscriptionConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
        }
    } catch (e) {
        console.error(`[VALIDATE ERROR] contact ${contactId}:`, e.message);
    }
}

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
    } catch (error) {
        console.error(`[ATTR FAIL] ${contactId}:`, error.message);
    }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    const body = req.body;
    const topic = body.topic;
    const item = body.data?.item;
    if (!item) return res.status(200).json({ ok: true });

    const conversationId = item.id;
    let contactId = item.contacts?.contacts?.[0]?.id || item.author?.id;

    // === PRESALE ЛОГІКА ===
    if (topic === 'admin.logged_in' || 
       (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false)) {
        processSnoozedForAdmin(item.id);
        return res.status(200).json({ ok: true });
    }

    // Передача від бота
    if (topic === 'conversation.admin.assigned') {
        const prev = item.previous_assignee || (item.conversation_parts?.conversation_parts?.[0]?.assignee);
        const assignee = item.assignee;
        
        const isTransferFromBot = (prev?.type === 'bot' || (prev?.type === 'admin' && prev.id?.startsWith('bot_')))
                               && assignee?.type === 'team';
        
        if (isTransferFromBot && !processedTransferConversations.has(conversationId)) {
            processedTransferConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Чат передано з бота на команду presale/support', 5000);
        }
        if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
        return res.status(200).json({ ok: true });
    }

    if (topic === 'conversation.user.replied') {
        if (contactId && conversationId) await validateAndSetCustom(contactId, conversationId);
        return res.status(200).json({ ok: true });
    }

    if (contactId && conversationId) {
        await validateAndSetCustom(contactId, conversationId);
    }

    res.status(200).json({ ok: true });
});

app.head('/validate-email', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3000, () => {
    console.log('Webhook активний: presale ноут + unsnooze ТІЛЬКИ в тих чатах, куди ставимо ноут (один раз на день)');
});
