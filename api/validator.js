const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === ПЕРЕМЕННЫЕ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const PRESALE_TEAM_ID = process.env.PRESALE_TEAM_ID;
const CUSTOM_ATTR_NAME = process.env.CUSTOM_ATTR_NAME || 'Unpaid Custom';
const FOLLOW_UP_ATTR = 'Follow-Up';
const PRESALE_NOTE_TEXT = process.env.PRESALE_NOTE_TEXT || 'Агент вийшов в онлайн — перевіряємо snoozed чати presale 😎';
const INTERCOM_VERSION = '2.14';

// Точный текст для ноута подписки
const SUBSCRIPTION_NOTE_TEXT = 'Заповніть будь ласка subscription 😇🙏';

const processedSubscriptionConversations = new Set();

// === ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ЗАПРОСОВ ===
async function intercomRequest(method, endpoint, data = null) {
  try {
    const config = {
      method: method,
      url: `https://api.intercom.io${endpoint}`,
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
      }
    };
    if (data) config.data = data;
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(`[INTERCOM API ERROR] ${endpoint}:`, error.response?.data || error.message);
    throw error;
  }
}

// === ЛОГИКА 1: UNPAID И SUBSCRIPTION ===
async function validateAndSetCustom(contactId, conversationId) {
  if (!contactId || !conversationId) return;

  try {
    // 1. Получаем данные чата, чтобы проверить, не висит ли он на боте
    const conversation = await intercomRequest('get', `/conversations/${conversationId}`);
    const assignee = conversation.assignee;
    
    // Пропускаем, если чат все еще у бота
    if (!assignee || assignee.type === 'bot' || (assignee.type === 'admin' && assignee.id?.startsWith('bot_'))) {
      console.log(`[SKIP] Чат ${conversationId} находится у бота. Пропускаем.`);
      return;
    }

    // 2. Получаем данные контакта для проверки email и подписки
    const contact = await intercomRequest('get', `/contacts/${contactId}`);
    const email = contact.email;
    const purchaseEmail = contact.custom_attributes?.['Purchase email'];
    const subscription = contact.custom_attributes?.subscription;

    // --- Логика Unpaid ---
    let emailsToCheck = [];
    if (email) emailsToCheck.push(email.toLowerCase().trim());
    if (purchaseEmail) emailsToCheck.push(purchaseEmail.toLowerCase().trim());

    if (emailsToCheck.length > 0 && LIST_URL) {
      const listRes = await axios.get(LIST_URL);
      const apiEmails = listRes.data.map(item => item.email.toLowerCase().trim());
      
      const isUnpaid = emailsToCheck.some(e => apiEmails.includes(e));
      if (isUnpaid) {
        await intercomRequest('put', `/contacts/${contactId}`, {
          custom_attributes: { [CUSTOM_ATTR_NAME]: true }
        });
      }
    }

    // --- Логика Subscription ---
    if (!subscription && !processedSubscriptionConversations.has(conversationId)) {
      await intercomRequest('post', `/conversations/${conversationId}/reply`, {
        message_type: 'note',
        type: 'admin',
        admin_id: ADMIN_ID,
        body: SUBSCRIPTION_NOTE_TEXT
      });
      processedSubscriptionConversations.add(conversationId);
      console.log(`[SUBSCRIPTION] Отправлен ноут в чат ${conversationId}`);
    }

  } catch (error) {
    console.error(`[VALIDATE FAIL] Чат ${conversationId}:`, error.message);
  }
}

// === ЛОГИКА 2: PRESALE CHATS ===
async function checkPresaleSnoozedChats() {
  try {
    const startOfTodayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

    // Ищем все снуз-чаты, где последнее обновление было ДО сегодняшнего дня.
    // Фильтр по команде убран из API-запроса, чтобы избежать таймаутов.
    const searchBody = {
      query: {
        operator: "AND", 
        value: [
          { field: "state", operator: "=", value: "snoozed" },
          { field: "updated_at", operator: "<", value: startOfTodayUnix }
        ]
      },
      pagination: { per_page: 50 }
    };

    const searchRes = await intercomRequest('post', '/conversations/search', searchBody);
    const allSnoozedChats = searchRes.conversations || [];

    // Фильтруем по команде Presale уже в коде
    const teamConversations = allSnoozedChats.filter(conv => 
      conv.team_assignee_id === PRESALE_TEAM_ID || 
      conv.team_assignee_id === Number(PRESALE_TEAM_ID) ||
      (conv.assignee && conv.assignee.id === PRESALE_TEAM_ID)
    );

    console.log(`[PRESALE] Найдено ${teamConversations.length} старых snoozed чатов для команды.`);

    for (const conv of teamConversations) {
      // Исключаем чаты с ботом
      const assignee = conv.assignee;
      if (assignee?.type === 'bot' || (assignee?.type === 'admin' && assignee.id?.startsWith('bot_'))) {
        console.log(`[PRESALE SKIP] Чат ${conv.id} все еще у бота.`);
        continue;
      }

      // Проверяем наличие атрибута Follow-Up
      const hasFollowUp = conv.custom_attributes?.[FOLLOW_UP_ATTR] === true || conv.custom_attributes?.[FOLLOW_UP_ATTR] === 'true';
      if (hasFollowUp) {
        console.log(`[PRESALE SKIP] В чате ${conv.id} стоит Follow-Up.`);
        continue;
      }

      // Добавляем ноут и снузим на 1 минуту для "пробуждения"
      const snoozeUntil = Math.floor(Date.now() / 1000) + 60; // Текущее время + 60 секунд
      
      await intercomRequest('post', `/conversations/${conv.id}/reply`, {
        message_type: 'note',
        type: 'admin',
        admin_id: ADMIN_ID,
        body: PRESALE_NOTE_TEXT
      });

      await intercomRequest('put', `/conversations/${conv.id}`, {
        state: 'snoozed',
        snoozed_until: snoozeUntil
      });

      console.log(`[PRESALE ACTION] Чат ${conv.id} выведен в снуз на 1 минуту с ноутом.`);
    }

  } catch (error) {
    console.error(`[PRESALE ERROR]:`, error.message);
  }
}

// === ВЕБХУКИ ===
app.post('/validate-email', async (req, res) => {
  const body = req.body;
  const topic = body.topic;
  
  // Отвечаем Intercom сразу, чтобы вебхук не отваливался
  res.status(200).json({ ok: true });

  if (topic === 'conversation.user.created' || topic === 'conversation.admin.replied' || topic === 'conversation.user.replied') {
    const contactId = body.data?.item?.user?.id;
    const conversationId = body.data?.item?.id;
    await validateAndSetCustom(contactId, conversationId);
  }

  if (topic === 'admin.away_mode_updated') {
    const adminId = body.data?.item?.admin?.id;
    const awayMode = body.data?.item?.away_mode_enabled;
    const adminType = body.data?.item?.admin?.type;

    console.log(`[WEBHOOK] Статус изменен: ID ${adminId}, Away Mode: ${awayMode}`);

    // Если оператор вернулся (выключил away_mode)
    if (awayMode === false && adminType !== 'bot') {
      console.log(`[ACTION] Агент ${adminId} вернулся онлайн! Запускаю проверку пресейлов...`);
      await checkPresaleSnoozedChats();
    }
  }
});

app.head('/validate-email', (req, res) => res.status(200).end());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

module.exports = app;
