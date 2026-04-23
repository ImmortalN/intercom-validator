const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ENV ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const ADMIN_ID = process.env.ADMIN_ID;           // системний адмін для нотів
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_FOLLOWUP_TAG_ID = '13404165';     // якщо хочеш додавати тег

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

const processedToday = new Map(); // adminId → YYYY-MM-DD

// === LOGGING ===
function log(...args) {
    if (DEBUG) console.log(...args);
}

console.log('Webhook запущено — presale ноут тільки при першому онлайн + один раз на день');

// === ОДИН РАЗ НА ДЕНЬ ===
function canShowPresaleNote(adminId) {
    const todayStr = new Date().toISOString().split('T')[0];
    if (processedToday.has(adminId) && processedToday.get(adminId) === todayStr) {
        log(`[PRESALE SKIP] Вже обробляли сьогодні для admin ${adminId}`);
        return false;
    }
    processedToday.set(adminId, todayStr);
    log(`[PRESALE ALLOWED] Перший logged_in / away_mode=false сьогодні для ${adminId}`);
    return true;
}

// === UNSNOOZE через reply open ===
async function unsnoozeConversation(convId) {
    try {
        await axios.post(`https://api.intercom.io/conversations/${convId}/reply`, {
            message_type: 'open',
            admin_id: ADMIN_ID
        }, {
            headers: {
                Authorization: `Bearer ${INTERCOM_TOKEN}`,
                'Intercom-Version': INTERCOM_VERSION,
                'Content-Type': 'application/json'
            }
        });
        log(`✅ Unsnoozed ${convId}`);
    } catch (e) {
        console.error(`[UNSNZ FAIL] ${convId}:`, e.response?.data || e.message);
    }
}

// === RESNOOZE на 1 хвилину (якщо хочеш альтернативу) ===
async function resnoozeConversation(convId) {
    const snoozeUntil = Math.floor(Date.now() / 1000) + 60; // +1 min
    try {
        await axios.post(`https://api.intercom.io/conversations/${convId}/reply`, {
            message_type: 'snoozed',
            snoozed_until: snoozeUntil,
            admin_id: ADMIN_ID
        }, {
            headers: {
                Authorization: `Bearer ${INTERCOM_TOKEN}`,
                'Intercom-Version': INTERCOM_VERSION,
                'Content-Type': 'application/json'
            }
        });
        log(`⏰ Resnoozed ${convId} на 1 хв`);
    } catch (e) {
        console.error(`[RESNOOZE FAIL] ${convId}:`, e.response?.data || e.message);
    }
}

// === NOTE з затримкою ===
async function addNoteWithDelay(convId, text, delayMs = 2500) {
    setTimeout(async () => {
        try {
            await axios.post(`https://api.intercom.io/conversations/${convId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: text
            }, {
                headers: {
                    Authorization: `Bearer ${INTERCOM_TOKEN}`,
                    'Intercom-Version': INTERCOM_VERSION,
                    'Content-Type': 'application/json'
                }
            });
            log(`📝 Note added: "${text.slice(0, 80)}..." → ${convId}`);
        } catch (e) {
            console.error(`[NOTE FAIL] ${convId}:`, e.response?.data || e.message);
        }
    }, delayMs);
}

// === CHECK Follow-Up ===
async function isFollowUpBlocked(convId) {
    try {
        const res = await axios.get(`https://api.intercom.io/conversations/${convId}`, {
            headers: {
                Authorization: `Bearer ${INTERCOM_TOKEN}`,
                'Intercom-Version': INTERCOM_VERSION
            }
        });
        return res.data.custom_attributes?.[FOLLOW_UP_ATTR] === true;
    } catch (e) {
        log(`[FOLLOW-UP CHECK FAIL] ${convId}`, e.message);
        return false;
    }
}

// === ОБРОБКА ОДНОГО ЧАТУ ===
async function processSingleConversation(convId) {
    if (!convId) return;

    if (await isFollowUpBlocked(convId)) {
        log(`⛔ SKIP ${convId} — Follow-Up = true`);
        return;
    }

    // Варіант 1 (рекомендую) — просто розснузити + ноут
    await unsnoozeConversation(convId);
    await addNoteWithDelay(convId, PRESALE_NOTE_TEXT, 3000);

    // Варіант 2 (якщо хочеш resnooze) — розкоментуй і закоментуй unsnooze
    // await resnoozeConversation(convId);
    // await addNoteWithDelay(convId, PRESALE_NOTE_TEXT, 4000);

    // Опціонально тег
    // await addTag(convId);
}

// === PRESALE PROCESSING (з пагінацією) ===
async function processSnoozedPresale(adminId) {
    if (!PRESALE_TEAM_ID || !canShowPresaleNote(adminId)) return;

    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const todayMidnightUnix = Math.floor(todayMidnight.getTime() / 1000);

    log(`[PRESALE START] Шукаємо snoozed чати presale з snoozed_until < ${todayMidnight.toISOString()}`);

    let startingAfter = null;
    let processed = 0;

    try {
        do {
            const searchBody = {
                query: {
                    operator: "AND",
                    value: [
                        { field: "team_assignee_id", operator: "=", value: PRESALE_TEAM_ID },
                        { field: "state", operator: "=", value: "snoozed" },
                        { field: "snoozed_until", operator: "<", value: todayMidnightUnix }
                    ]
                },
                pagination: { per_page: 50 }
            };
            if (startingAfter) searchBody.pagination.starting_after = startingAfter;

            const res = await axios.post('https://api.intercom.io/conversations/search', searchBody, {
                headers: {
                    Authorization: `Bearer ${INTERCOM_TOKEN}`,
                    'Intercom-Version': INTERCOM_VERSION,
                    'Content-Type': 'application/json'
                }
            });

            const convs = res.data.conversations || [];
            log(`[SEARCH] Знайдено ${convs.length} старих snoozed чатів`);

            for (const conv of convs) {
                await processSingleConversation(conv.id);
                processed++;
                await new Promise(r => setTimeout(r, 800)); // анти-rate-limit
            }

            startingAfter = res.data.pages?.next?.starting_after;
        } while (startingAfter);

        log(`[PRESALE FINISH] Оброблено чатів: ${processed}`);
    } catch (e) {
        console.error('[PRESALE ERROR]', e.response?.data || e.message);
    }
}

// === EMAIL + SUBSCRIPTION (з твого першого коду) ===
const processedSubscriptionConversations = new Set();

async function validateAndSetCustom(contactId, conversationId) {
    if (!contactId || !conversationId) return;

    try {
        const { data: contact } = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: { Authorization: `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION }
        });

        // Unpaid Custom
        const emails = [contact.email, contact.custom_attributes?.['Purchase email']].filter(Boolean);
        if (emails.length) {
            const { data: emailList } = await axios.get(LIST_URL, { timeout: 5000 });
            const isMatch = emails.some(e =>
                emailList.some(le => (le || '').trim().toLowerCase() === e.trim().toLowerCase())
            );
            if (isMatch && contact.custom_attributes?.[CUSTOM_ATTR_NAME] !== true) {
                await axios.put(`https://api.intercom.io/contacts/${contactId}`, {
                    custom_attributes: { [CUSTOM_ATTR_NAME]: true }
                }, { headers: { Authorization: `Bearer ${INTERCOM_TOKEN}`, 'Intercom-Version': INTERCOM_VERSION } });
                log(`💰 Unpaid Custom = true для ${contactId}`);
            }
        }

        // Subscription note
        const subscription = contact.custom_attributes?.['Subscription'] || '';
        if (!subscription.trim() && !processedSubscriptionConversations.has(conversationId)) {
            processedSubscriptionConversations.add(conversationId);
            await addNoteWithDelay(conversationId, 'Заповніть будь ласка subscription 😇🙏', 10000);
        }
    } catch (e) {
        console.error(`[VALIDATE ERROR] contact ${contactId}:`, e.message);
    }
}

// === WEBHOOK ===
app.post('/validate-email', async (req, res) => {
    console.log('🔥 WEBHOOK HIT');
    console.log('Full payload:', JSON.stringify(req.body, null, 2));   // ← дуже важливо для дебагу!

    const topic = req.body.topic;
    const item = req.body.data?.item || req.body.item;   // іноді структура трохи відрізняється

    if (!item) return res.sendStatus(200);

    // === PRESALE: admin online ===
    if (topic === 'admin.logged_in' ||
        (topic === 'admin.away_mode_updated' && item.away_mode_enabled === false)) {

        const adminId = item.id || item.admin_id;
        if (adminId) {
            console.log(`👀 Admin ${adminId} online → запускаємо presale`);
            processSnoozedPresale(adminId);
        }
        return res.sendStatus(200);
    }

    // === EMAIL + SUBSCRIPTION ===
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id ||
                      item.author?.id ||
                      item.user?.id;

    if ((topic === 'conversation.user.replied' ||
         topic === 'conversation.user.created' ||
         topic === 'conversation.admin.assigned') && contactId && conversationId) {

        await validateAndSetCustom(contactId, conversationId);
    }

    res.sendStatus(200);
});

app.get('/', (req, res) => res.send('Webhook OK'));

app.listen(process.env.PORT || 3000, () => {
    console.log('🚀 Webhook активний на порту', process.env.PORT || 3000);
});
