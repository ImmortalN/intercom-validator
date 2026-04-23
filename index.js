const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ================= ENV =================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;

const INTERCOM_VERSION = '2.14';

const CUSTOM_ATTR_NAME = 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';

const PRESALE_NOTE_TEXT =
  process.env.PRESALE_NOTE_TEXT ||
  'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';

// ================= STATE =================
// adminId → { date, lastAwayState }
const presaleState = new Map();

// conversationId → processed flags
const processedConversations = new Set();

// ================= LOG =================
function log(...args) {
  console.log('[DEBUG]', ...args);
}

// ================= INTERCOM =================
async function intercomRequest(method, url, data) {
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

// ================= EMAIL CHECK =================
async function validateEmail(contactId) {
  if (!contactId || !LIST_URL) return;

  try {
    const contact = await intercomRequest('get', `/contacts/${contactId}`);

    const emails = [
      contact.data.email,
      contact.data.custom_attributes?.['Purchase email']
    ].filter(Boolean);

    if (!emails.length) return;

    const { data: list } = await axios.get(LIST_URL);

    const match = emails.some(e =>
      list.some(l =>
        (l || '').toLowerCase().trim() === e.toLowerCase().trim()
      )
    );

    if (match) {
      await intercomRequest('put', `/contacts/${contactId}`, {
        custom_attributes: {
          [CUSTOM_ATTR_NAME]: true
        }
      });

      log(`💰 Unpaid set for ${contactId}`);
    }
  } catch (e) {
    console.error('[EMAIL ERROR]', e.message);
  }
}

// ================= SUBSCRIPTION CHECK =================
async function checkSubscription(conversationId, contact) {
  const subscription =
    contact.custom_attributes?.Subscription ||
    contact.custom_attributes?.subscription;

  if (!subscription || subscription.trim() === '') {
    await intercomRequest('post', `/conversations/${conversationId}/reply`, {
      message_type: 'note',
      admin_id: ADMIN_ID,
      body: 'Please fill subscription 😇'
    });

    log(`📝 subscription note → ${conversationId}`);
  }
}

// ================= PRESALE HELPERS =================
function isFirstExitToday(adminId) {
  const today = new Date().toISOString().split('T')[0];
  const state = presaleState.get(adminId);

  return state?.lastDate !== today;
}

function updateAdminState(adminId, awayMode) {
  const today = new Date().toISOString().split('T')[0];

  presaleState.set(adminId, {
    lastDate: today,
    lastAwayState: awayMode
  });
}

// ================= LAST MESSAGE CHECK =================
async function lastMessageNotToday(conversationId) {
  const res = await intercomRequest(
    'get',
    `/conversations/${conversationId}`
  );

  const last =
    res.data.conversation_parts?.conversation_parts?.at(-1);

  if (!last?.created_at) return true;

  const lastDate = new Date(last.created_at * 1000);
  const today = new Date();

  return lastDate.toDateString() !== today.toDateString();
}

// ================= PRESALE CORE =================
async function processPresale(adminId) {
  const today = new Date().toISOString().split('T')[0];

  if (!PRESALE_TEAM_ID) return;

  log('🚀 PRESALE START');

  try {
    const todayMidnight = Math.floor(
      new Date().setHours(0, 0, 0, 0) / 1000
    );

    const res = await intercomRequest('post', '/conversations/search', {
      query: {
        operator: 'AND',
        value: [
          {
            field: 'team_assignee_id',
            operator: '=',
            value: PRESALE_TEAM_ID
          },
          {
            field: 'state',
            operator: '=',
            value: 'snoozed'
          },
          {
            field: 'snoozed_until',
            operator: '<',
            value: todayMidnight
          }
        ]
      }
    });

    const conversations = res.data.conversations || [];

    for (const conv of conversations) {
      if (processedConversations.has(conv.id)) continue;

      const full = await intercomRequest(
        'get',
        `/conversations/${conv.id}`
      );

      const followUp =
        full.data.custom_attributes?.[FOLLOW_UP_ATTR];

      if (followUp === true) {
        log(`⛔ skip follow-up ${conv.id}`);
        continue;
      }

      if (!(await lastMessageNotToday(conv.id))) {
        log(`⛔ skip last message today ${conv.id}`);
        continue;
      }

      // unsnooze
      await intercomRequest(
        'post',
        `/conversations/${conv.id}/reply`,
        {
          message_type: 'open',
          admin_id: ADMIN_ID
        }
      );

      // note
      await intercomRequest(
        'post',
        `/conversations/${conv.id}/reply`,
        {
          message_type: 'note',
          admin_id: ADMIN_ID,
          body: PRESALE_NOTE_TEXT
        }
      );

      processedConversations.add(conv.id);

      log(`✅ presale processed ${conv.id}`);

      await new Promise(r => setTimeout(r, 400));
    }

    log('✅ PRESALE DONE');
  } catch (e) {
    console.error('[PRESALE ERROR]', e.message);
  }
}

// ================= WEBHOOK =================
app.post('/validate-email', async (req, res) => {
  // ⚠️ СРАЗУ ОТДАЁМ ОТВЕТ INTERCOM
  res.sendStatus(200);

  // ВСЁ ДАЛЬНЕЙШЕЕ — АСИНХРОННО
  setImmediate(async () => {
    try {
      const body = req.body;
      const topic = body.topic;
      const item = body.data?.item;

      console.log('🔥 WEBHOOK RECEIVED:', topic);

      if (!item) return;

      const conversationId = item.id;
      const contactId =
        item.contacts?.contacts?.[0]?.id ||
        item.author?.id;

      // ================= PRESALE =================
      if (topic === 'admin.away_mode_updated') {
        const isAway = item.away_mode_enabled;

        updateAdminState(item.id, isAway);

        if (isAway === false && isFirstExitToday(item.id)) {
          await processPresale(item.id);
        }
      }

      // ================= EMAIL =================
      if (contactId) {
        await validateEmail(contactId);
      }

      // ================= SUBSCRIPTION =================
      if (conversationId && contactId) {
        const contact = await intercomRequest(
          'get',
          `/contacts/${contactId}`
        );

        await checkSubscription(conversationId, contact.data);
      }

    } catch (e) {
      console.error('🔥 ASYNC WEBHOOK ERROR:', e.message);
    }
  });
});

// ================= START =================
app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 FINAL PRESALE ENGINE RUNNING');
});
