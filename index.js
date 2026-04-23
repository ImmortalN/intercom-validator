const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ===== BASIC ROUTE (for health + testing) =====
app.get('/', (req, res) => {
  console.log('✅ Health check hit');
  res.send('OK');
});

// ===== GLOBAL LOGGER =====
app.use((req, res, next) => {
  console.log(`[GLOBAL LOG] ${new Date().toISOString()} | ${req.method} ${req.url}`);
  next();
});

// ===== ENV VARIABLES =====
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID; // system admin (IMPORTANT)
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const LIST_URL = process.env.LIST_URL;

const INTERCOM_VERSION = '2.14';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = 'Агент вийшов онлайн — перевіряємо старі presale чати 😎';

const processedToday = new Map();

// ===== HELPERS =====
function log(...args) {
  console.log('[DEBUG]', ...args);
}

function canRunOncePerDay(adminId) {
  const today = new Date().toISOString().split('T')[0];
  if (processedToday.get(adminId) === today) return false;
  processedToday.set(adminId, today);
  return true;
}

async function intercomRequest(method, url, data = {}) {
  return axios({
    method,
    url: `https://api.intercom.io${url}`,
    data,
    headers: {
      Authorization: `Bearer ${INTERCOM_TOKEN}`,
      'Intercom-Version': INTERCOM_VERSION,
      'Content-Type': 'application/json'
    }
  });
}

// ===== CORE FIX: RESNOOZE =====
async function resnoozeConversation(conversationId) {
  const snoozeUntil = Math.floor(Date.now() / 1000) + 60; // +1 min

  try {
    await intercomRequest('post', `/conversations/${conversationId}/snooze`, {
      snoozed_until: snoozeUntil,
      admin_id: ADMIN_ID
    });
    log(`⏰ Resnoozed ${conversationId}`);
  } catch (e) {
    log('RESNOOZE ERROR', e.response?.data || e.message);
  }
}

async function addNote(conversationId, text) {
  try {
    await intercomRequest('post', `/conversations/${conversationId}/reply`, {
      message_type: 'note',
      admin_id: ADMIN_ID,
      body: text
    });
    log(`📝 Note added to ${conversationId}`);
  } catch (e) {
    log('NOTE ERROR', e.response?.data || e.message);
  }
}

// ===== PRESALE FLOW =====
async function processPresale(adminId) {
  if (!PRESALE_TEAM_ID) return;
  if (!canRunOncePerDay(adminId)) return;

  console.log(`🚀 PRESALE START for admin ${adminId}`);

  try {
    const todayMidnight = Math.floor(
      new Date().setHours(0, 0, 0, 0) / 1000
    );

    const res = await intercomRequest('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          { field: 'team_assignee_id', operator: '=', value: PRESALE_TEAM_ID },
          { field: 'state', operator: '=', value: 'snoozed' },
          { field: 'snoozed_until', operator: '<', value: todayMidnight }
        ]
      }
    });

    const conversations = res.data.conversations || [];

    for (const conv of conversations) {
      const full = await intercomRequest('get', `/conversations/${conv.id}`);

      if (full.data.custom_attributes?.[FOLLOW_UP_ATTR] === true) {
        log(`⛔ Skip ${conv.id} (Follow-Up)`);
        continue;
      }

      await resnoozeConversation(conv.id);
      await addNote(conv.id, PRESALE_NOTE_TEXT);
    }

    console.log(`✅ PRESALE DONE (${conversations.length})`);
  } catch (e) {
    console.error('PRESALE ERROR', e.response?.data || e.message);
  }
}

// ===== EMAIL VALIDATION =====
async function validateEmail(contactId, conversationId) {
  if (!contactId || !LIST_URL) return;

  try {
    const contactRes = await intercomRequest('get', `/contacts/${contactId}`);
    const contact = contactRes.data;

    const emails = [
      contact.email,
      contact.custom_attributes?.['Purchase email']
    ].filter(Boolean);

    if (!emails.length) return;

    const { data: list } = await axios.get(LIST_URL);

    const match = emails.some(e =>
      list.some(l => l.toLowerCase().trim() === e.toLowerCase().trim())
    );

    if (match) {
      await intercomRequest('put', `/contacts/${contactId}`, {
        custom_attributes: { 'Unpaid Custom': true }
      });
      log(`💰 Unpaid set for ${contactId}`);
    }
  } catch (e) {
    log('EMAIL ERROR', e.message);
  }
}

// ===== WEBHOOK =====
app.post('/validate-email', async (req, res) => {
  console.log('🔥 WEBHOOK HIT');

  const topic = req.body.topic;
  const item = req.body.data?.item;

  if (!item) return res.sendStatus(200);

  console.log(`📩 Topic: ${topic}`);

  // ===== ADMIN ONLINE =====
  if (topic === 'admin.away_mode_updated' || topic === 'admin.logged_in') {
    const isAway = item.away_mode_enabled ?? item.away_mode?.enabled;

    if (isAway === false) {
      console.log('👀 Admin online → run presale');
      processPresale(item.id);
    }
  }

  // ===== USER MESSAGE =====
  if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
    const contactId = item.contacts?.contacts?.[0]?.id;
    const conversationId = item.id;

    validateEmail(contactId, conversationId);
  }

  res.sendStatus(200);
});

// ===== START SERVER =====
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server started');
});
