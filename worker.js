const CONFIG = {
  ADMIN_TELEGRAM_ID: '6545688842',
  FRONTEND_URL: 'https://quran-ayah-quiz.vercel.app',
  SUPPORT_USERNAME: '@luck_7n',
  TELEBIRR_NUMBER: '0938054751',
  TELEBIRR_NAME: 'Lakin',
  PRO_STARS: 20,
  TELEBIRR_ETB: 50
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': CONFIG.FRONTEND_URL,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Telegram-Init-Data',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extra
    }
  });
}

function text(data, status = 200) {
  return new Response(data, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...CORS_HEADERS
    }
  });
}

function envValue(env, name, fallback = '') {
  return env[name] ?? fallback;
}

function supabaseKey(env) {
  return env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function supabaseBase(env) {
  return String(env.SUPABASE_URL || '').replace(/\/$/, '');
}

async function supabase(env, table, options = {}) {
  const base = supabaseBase(env);

  if (!base || !supabaseKey(env)) {
    throw new Error('Supabase is not configured.');
  }

  const url = new URL(`${base}/rest/v1/${table}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers = {
    apikey: supabaseKey(env),
    Authorization: `Bearer ${supabaseKey(env)}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined
      ? undefined
      : JSON.stringify(options.body)
  });

  const raw = await response.text();

  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      typeof data === 'object' && data?.message
        ? data.message
        : `Supabase request failed (${response.status})`
    );
  }

  return data;
}

async function telegramApi(env, method, body = {}) {
  const token = env.BOT_TOKEN;

  if (!token) {
    throw new Error('BOT_TOKEN is not configured.');
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || `Telegram API ${method} failed`
    );
  }

  return data.result;
}

function escapeTelegram(value) {
  return String(value ?? '').replace(
    /[<>&"]/g,
    c => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;'
    })[c]
  );
}

/* -------------------------------------------------------
   TELEGRAM WEB APP INIT DATA VALIDATION
------------------------------------------------------- */

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(message)
    )
  );
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function validateInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    throw new Error('Telegram initData is required.');
  }

  if (!botToken) {
    throw new Error('BOT_TOKEN is not configured.');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');

  if (!receivedHash) {
    throw new Error('Telegram hash missing.');
  }

  const authDate = Number(params.get('auth_date') || 0);

  if (
    !authDate ||
    Math.floor(Date.now() / 1000) - authDate > 24 * 60 * 60
  ) {
    throw new Error(
      'Telegram session expired. Reopen the Mini App.'
    );
  }

  params.delete('hash');

  const pairs = [];

  for (const [key, value] of params.entries()) {
    pairs.push([key, value]);
  }

  pairs.sort(([a], [b]) => a.localeCompare(b));

  const dataCheckString = pairs
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = await hmacSha256(
    new TextEncoder().encode('WebAppData'),
    botToken
  );

  const calculatedHash = bytesToHex(
    await hmacSha256(secretKey, dataCheckString)
  );

  if (calculatedHash !== receivedHash) {
    throw new Error('Invalid Telegram initData.');
  }

  let telegramUser;

  try {
    telegramUser = JSON.parse(
      params.get('user') || 'null'
    );
  } catch (_) {
    throw new Error('Invalid Telegram user data.');
  }

  if (!telegramUser?.id) {
    throw new Error('Telegram user missing.');
  }

  return telegramUser;
}

/* -------------------------------------------------------
   SUPABASE USER STORAGE
------------------------------------------------------- */

async function getUser(env, telegramUser) {
  const id = String(telegramUser.id);

  let rows;

  try {
    rows = await supabase(env, 'users', {
      query: {
        telegram_id: `eq.${id}`,
        select: '*',
        limit: '1'
      }
    });
  } catch (_) {
    /*
      Some existing databases may use "id" instead of
      "telegram_id". Try the alternative.
    */

    rows = await supabase(env, 'users', {
      query: {
        id: `eq.${id}`,
        select: '*',
        limit: '1'
      }
    });
  }

  if (Array.isArray(rows) && rows.length) {
    return rows[0];
  }

  const newUser = {
    telegram_id: id,
    first_name: telegramUser.first_name || '',
    last_name: telegramUser.last_name || '',
    username: telegramUser.username || '',
    is_pro: id === CONFIG.ADMIN_TELEGRAM_ID,
    created_at: new Date().toISOString()
  };

  try {
    const created = await supabase(env, 'users', {
      method: 'POST',
      query: {
        select: '*'
      },
      headers: {
        Prefer: 'return=representation'
      },
      body: newUser
    });

    if (Array.isArray(created) && created.length) {
      return created[0];
    }

    return newUser;
  } catch (_) {
    return newUser;
  }
}

async function updateUser(env, telegramUser, patch) {
  const id = String(telegramUser.id);

  const data = {
    ...patch,
    updated_at: new Date().toISOString()
  };

  try {
    return await supabase(env, 'users', {
      method: 'PATCH',
      query: {
        telegram_id: `eq.${id}`,
        select: '*'
      },
      headers: {
        Prefer: 'return=representation'
      },
      body: data
    });
  } catch (_) {
    return await supabase(env, 'users', {
      method: 'PATCH',
      query: {
        id: `eq.${id}`,
        select: '*'
      },
      headers: {
        Prefer: 'return=representation'
      },
      body: data
    });
  }
}

/* -------------------------------------------------------
   PUBLIC USER
------------------------------------------------------- */

function publicUser(account, telegramUser) {
  const id = String(telegramUser.id);

  return {
    id,
    first_name: telegramUser.first_name || '',
    last_name: telegramUser.last_name || '',
    username: telegramUser.username || '',
    isPro:
      id === CONFIG.ADMIN_TELEGRAM_ID ||
      Boolean(account?.is_pro) ||
      Boolean(account?.isPro),
    isAdmin: id === CONFIG.ADMIN_TELEGRAM_ID
  };
}

/* -------------------------------------------------------
   WEBHOOK SETUP
------------------------------------------------------- */

async function setupWebhook(request, env) {
  let setupSecret = '';

  /*
    GET:
    /api/setup-webhook?setupSecret=YOUR_SECRET

    POST:
    {"setupSecret":"YOUR_SECRET"}
  */

  if (request.method === 'GET') {
    const url = new URL(request.url);
    setupSecret = url.searchParams.get('setupSecret') || '';
  } else {
    let body = {};

    try {
      body = await request.json();
    } catch (_) {}

    setupSecret = body.setupSecret || '';
  }

  const expected = env.WEBHOOK_SETUP_SECRET || '';

  if (!expected) {
    return json(
      {
        ok: false,
        error: 'WEBHOOK_SETUP_SECRET is not configured in Cloudflare.'
      },
      500
    );
  }

  if (!setupSecret || setupSecret !== expected) {
    return json(
      {
        ok: false,
        error: 'Invalid setup secret.'
      },
      401
    );
  }

  const webhookUrl =
    new URL(request.url).origin + '/telegram/webhook';

  const secretToken =
    env.TELEGRAM_WEBHOOK_SECRET || '';

  if (!secretToken) {
    return json(
      {
        ok: false,
        error: 'TELEGRAM_WEBHOOK_SECRET is not configured in Cloudflare.'
      },
      500
    );
  }

  try {
    const result = await telegramApi(
      env,
      'setWebhook',
      {
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: [
          'message',
          'callback_query',
          'pre_checkout_query'
        ],
        drop_pending_updates: false
      }
    );

    return json({
      ok: true,
      message: 'Telegram webhook activated successfully.',
      webhookUrl,
      telegram: result
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error.message
      },
      500
    );
  }
}

/* -------------------------------------------------------
   TELEGRAM WEBHOOK SECURITY
------------------------------------------------------- */

function verifyTelegramWebhook(request, env) {
  const expected = env.TELEGRAM_WEBHOOK_SECRET || '';

  if (!expected) return false;

  const received =
    request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';

  return received === expected;
}

/* -------------------------------------------------------
   TELEGRAM BOT COMMANDS
------------------------------------------------------- */

async function sendStart(env, chatId) {
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text:
      'Assalamu alaikum 🌙\n\n' +
      'Welcome to آيَة | Ayah Quest.\n\n' +
      'Memorize. Revise. Stay consistent. 📖✨',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '📖 Open Ayah Quest',
            web_app: {
              url: CONFIG.FRONTEND_URL
            }
          }
        ],
        [
          {
            text: '💎 Pro',
            callback_data: 'menu_pro'
          },
          {
            text: '👤 Profile',
            callback_data: 'menu_profile'
          }
        ],
        [
          {
            text: '❓ Help',
            callback_data: 'menu_help'
          },
          {
            text: '💬 Support',
            callback_data: 'menu_support'
          }
        ]
      ]
    }
  });
}

async function sendPro(env, chatId) {
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text:
      '💎 <b>Ayah Quest Pro</b>\n\n' +
      'Unlock unlimited practice and advanced revision features.\n\n' +
      `⭐ Telegram Stars: <b>${CONFIG.PRO_STARS} XTR</b>\n` +
      `💰 Telebirr: <b>${CONFIG.TELEBIRR_ETB} ETB</b>\n\n` +
      'Open the Mini App to upgrade.',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '📖 Open Ayah Quest',
            web_app: {
              url: CONFIG.FRONTEND_URL
            }
          }
        ]
      ]
    }
  });
}

async function sendHelp(env, chatId) {
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text:
      '❓ <b>Ayah Quest Help</b>\n\n' +
      '📖 Practice Quran ayahs\n' +
      '🧠 Test your memory\n' +
      '🔖 Bookmark difficult ayahs\n' +
      '📚 Review your mistakes\n' +
      '💎 Upgrade to Pro for unlimited practice\n\n' +
      `💬 Support: ${CONFIG.SUPPORT_USERNAME}`,
    parse_mode: 'HTML'
  });
}

async function sendAbout(env, chatId) {
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text:
      '📖 <b>آيَة | Ayah Quest</b>\n\n' +
      'A Quran memorization companion designed to help you practice consistently, one ayah at a time.\n\n' +
      'May Allah make the Quran the light of our hearts. 🤍',
    parse_mode: 'HTML'
  });
}

async function sendSupport(env, chatId) {
  await telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text:
      `💬 Support: ${CONFIG.SUPPORT_USERNAME}\n\n` +
      'If you have a payment or account problem, contact support.'
  });
}

/* -------------------------------------------------------
   CALLBACKS
------------------------------------------------------- */

async function handleCallback(env, callback) {
  const data = callback.data || '';
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  const fromId = String(callback.from?.id || '');

  if (data === 'menu_pro') {
    await telegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callback.id
    });

    if (chatId) {
      await sendPro(env, chatId);
    }

    return;
  }

  if (data === 'menu_help') {
    await telegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callback.id
    });

    if (chatId) {
      await sendHelp(env, chatId);
    }

    return;
  }

  if (data === 'menu_support') {
    await telegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callback.id
    });

    if (chatId) {
      await sendSupport(env, chatId);
    }

    return;
  }

  if (data === 'menu_profile') {
    await telegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callback.id
    });

    if (chatId) {
      const user = callback.from;

      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text:
          '👤 <b>Your Ayah Quest Profile</b>\n\n' +
          `Name: ${escapeTelegram(
            [user.first_name, user.last_name]
              .filter(Boolean)
              .join(' ') || 'Quran learner'
          )}\n` +
          `Username: ${
            user.username
              ? '@' + escapeTelegram(user.username)
              : 'None'
          }`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📖 Open Profile',
                web_app: {
                  url: CONFIG.FRONTEND_URL
                }
              }
            ]
          ]
        }
      });
    }

    return;
  }

  /* Telebirr approval */

  const approveMatch = data.match(/^tb_approve_(\d+)$/);

  if (approveMatch) {
    if (fromId !== CONFIG.ADMIN_TELEGRAM_ID) {
      await telegramApi(env, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Not authorized.',
        show_alert: true
      });
      return;
    }

    const userId = approveMatch[1];

    try {
      await supabase(env, 'users', {
        method: 'PATCH',
        query: {
          telegram_id: `eq.${userId}`
        },
        headers: {
          Prefer: 'return=minimal'
        },
        body: {
          is_pro: true,
          telebirr_status: 'approved',
          telebirr_approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      });
    } catch (_) {
      try {
        await supabase(env, 'users', {
          method: 'PATCH',
          query: {
            id: `eq.${userId}`
          },
          headers: {
            Prefer: 'return=minimal'
          },
          body: {
            is_pro: true,
            telebirr_status: 'approved',
            telebirr_approved_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Telebirr approval DB error:', error);
      }
    }

    try {
      await telegramApi(env, 'sendMessage', {
        chat_id: userId,
        text:
          '🎉 <b>Ayah Quest Pro activated!</b>\n\n' +
          'Your Telebirr payment has been approved.\n' +
          'Reopen the Mini App to unlock Pro.',
        parse_mode: 'HTML'
      });
    } catch (_) {}

    await telegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Pro approved.'
    });

    if (chatId && messageId) {
      try {
        await telegramApi(env, 'editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: []
          }
        });
      } catch (_) {}
    }

    return;
  }

  const rejectMatch = data.match(/^tb_reject_(\d+)$/);

  if (rejectMatch) {
    if (fromId !== CONFIG.ADMIN_TELEGRAM_ID) {
      await telegramApi(env, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: 'Not authorized.',
        show_alert: true
      });
      return;
    }

    const userId = rejectMatch[1];

    try {
      await supabase(env, 'users', {
        method: 'PATCH',
        query: {
          telegram_id: `eq.${userId}`
        },
        headers: {
          Prefer: 'return=minimal'
        },
        body: {
          telebirr_status: 'rejected',
          updated_at: new Date().toISOString()
        }
      });
    } catch (_) {}

    try {
      await telegramApi(env, 'sendMessage', {
        chat_id: userId,
        text:
          'Your Telebirr Pro request was not approved.\n\n' +
          `Please contact ${CONFIG.SUPPORT_USERNAME} with your receipt.`
      });
    } catch (_) {}

    await telegramApi(env, 'answerCallbackQuery', {
      callback_query_id: callback.id,
      text: 'Request rejected.'
    });

    if (chatId && messageId) {
      try {
        await telegramApi(env, 'editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: {
            inline_keyboard: []
          }
        });
      } catch (_) {}
    }

    return;
  }

  await telegramApi(env, 'answerCallbackQuery', {
    callback_query_id: callback.id
  });
}

/* -------------------------------------------------------
   TELEGRAM MESSAGE HANDLER
------------------------------------------------------- */

async function handleTelegramUpdate(env, update) {
  /* Callback query */

  if (update.callback_query) {
    await handleCallback(
      env,
      update.callback_query
    );
    return;
  }

  /* Pre-checkout query */

  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;

    const expectedPayload =
      `ayahquiz_pro_${q.from.id}`;

    const valid =
      q.currency === 'XTR' &&
      Number(q.total_amount) === CONFIG.PRO_STARS &&
      q.invoice_payload === expectedPayload;

    await telegramApi(
      env,
      'answerPreCheckoutQuery',
      {
        pre_checkout_query_id: q.id,
        ok: valid,
        error_message: valid
          ? undefined
          : 'This Pro invoice is invalid or expired.'
      }
    );

    return;
  }

  const message = update.message;

  if (!message) return;

  const chatId = message.chat?.id;
  const from = message.from;

  if (!from || !chatId) return;

  /* Successful Stars payment */

  if (message.successful_payment) {
    const payment = message.successful_payment;

    const expectedPayload =
      `ayahquiz_pro_${from.id}`;

    if (
      payment.currency !== 'XTR' ||
      payment.invoice_payload !== expectedPayload ||
      Number(payment.total_amount) !== CONFIG.PRO_STARS
    ) {
      return;
    }

    try {
      await updateUser(
        env,
        from,
        {
          is_pro: true,
          stars_payment_id:
            payment.telegram_payment_charge_id || '',
          stars_amount:
            Number(payment.total_amount),
          stars_paid_at:
            new Date().toISOString()
        }
      );
    } catch (error) {
      console.error(
        'Stars payment DB error:',
        error
      );
    }

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text:
        '🎉 <b>Ayah Quest Pro activated!</b>\n\n' +
        'Your Telegram Stars payment was received successfully.\n' +
        'Open the Mini App again to refresh your Pro status.',
      parse_mode: 'HTML'
    });

    return;
  }

  /* Telebirr receipt photo */

  if (message.photo?.length) {
    const caption =
      message.caption || '';

    try {
      await telegramApi(env, 'sendMessage', {
        chat_id: CONFIG.ADMIN_TELEGRAM_ID,
        text:
          '🧾 <b>Ayah Quest Telebirr receipt</b>\n\n' +
          `User ID: <code>${from.id}</code>\n` +
          `Name: ${escapeTelegram(
            [from.first_name, from.last_name]
              .filter(Boolean)
              .join(' ')
          )}\n` +
          `Username: ${
            from.username
              ? '@' + escapeTelegram(from.username)
              : 'none'
          }\n\n` +
          `Caption: ${escapeTelegram(caption)}`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📖 Open Ayah Quest',
                web_app: {
                  url: CONFIG.FRONTEND_URL
                }
              }
            ]
          ]
        }
      });

      const photo =
        message.photo[
          message.photo.length - 1
        ];

      await telegramApi(
        env,
        'sendPhoto',
        {
          chat_id:
            CONFIG.ADMIN_TELEGRAM_ID,
          photo: photo.file_id,
          caption:
            `Telebirr receipt from ${from.id}`,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✅ Approve',
                  callback_data:
                    `tb_approve_${from.id}`
                },
                {
                  text: '❌ Reject',
                  callback_data:
                    `tb_reject_${from.id}`
                }
              ]
            ]
          }
        }
      );
    } catch (error) {
      console.error(
        'Receipt forwarding error:',
        error
      );
    }

    return;
  }

  /* Commands */

  const textValue =
    message.text || '';

  const command =
    textValue
      .split(/\s+/)[0]
      .split('@')[0]
      .toLowerCase();

  switch (command) {
    case '/start':
      await sendStart(env, chatId);
      break;

    case '/quiz':
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '📖 Open Ayah Quest to start practicing.',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📖 Start Practice',
                web_app: {
                  url: CONFIG.FRONTEND_URL
                }
              }
            ]
          ]
        }
      });
      break;

    case '/pro':
    case '/payment':
      await sendPro(env, chatId);
      break;

    case '/help':
      await sendHelp(env, chatId);
      break;

    case '/about':
      await sendAbout(env, chatId);
      break;

    case '/support':
      await sendSupport(env, chatId);
      break;

    case '/profile':
    case '/progress':
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '👤 Open Ayah Quest to view your profile and progress.',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '👤 Open Profile',
                web_app: {
                  url: CONFIG.FRONTEND_URL
                }
              }
            ]
          ]
        }
      });
      break;

    default:
      break;
  }
}

/* -------------------------------------------------------
   MAIN API
------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* CORS */

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    /* Health */

    if (
      url.pathname === '/api/health' &&
      request.method === 'GET'
    ) {
      return json({
        ok: true,
        service: 'Ayah Quest Cloudflare Worker',
        version: '4.0.0',
        botConfigured: Boolean(env.BOT_TOKEN),
        supabaseConfigured: Boolean(
          env.SUPABASE_URL &&
          supabaseKey(env)
        ),
        webhookConfigured: Boolean(
          env.TELEGRAM_WEBHOOK_SECRET
        )
      });
    }

    /* Root */

    if (
      url.pathname === '/' &&
      request.method === 'GET'
    ) {
      return json({
        ok: true,
        service: 'Ayah Quest backend',
        version: '4.0.0',
        platform: 'Cloudflare Workers'
      });
    }

    /* ---------------------------------------------------
       WEBHOOK ACTIVATION
    --------------------------------------------------- */

    if (
      url.pathname === '/api/setup-webhook' &&
      (request.method === 'GET' ||
       request.method === 'POST')
    ) {
      return setupWebhook(
        request,
        env
      );
    }

    /* ---------------------------------------------------
       TELEGRAM WEBHOOK
    --------------------------------------------------- */

    if (
      url.pathname === '/telegram/webhook'
    ) {
      if (request.method !== 'POST') {
        return text('Method Not Allowed', 405);
      }

      if (!verifyTelegramWebhook(request, env)) {
        return json(
          {
            ok: false,
            error: 'Unauthorized webhook request.'
          },
          401
        );
      }

      try {
        const update =
          await request.json();

        await handleTelegramUpdate(
          env,
          update
        );

        return json({
          ok: true
        });
      } catch (error) {
        console.error(
          'Webhook error:',
          error
        );

        return json({
          ok: true
        });
      }
    }

    /* ---------------------------------------------------
       AUTH
    --------------------------------------------------- */

    if (
      url.pathname === '/api/auth' &&
      request.method === 'POST'
    ) {
      try {
        const body =
          await request.json();

        const telegramUser =
          await validateInitData(
            body.initData,
            env.BOT_TOKEN
          );

        const account =
          await getUser(
            env,
            telegramUser
          );

        if (
          String(telegramUser.id) ===
          CONFIG.ADMIN_TELEGRAM_ID
        ) {
          try {
            await updateUser(
              env,
              telegramUser,
              {
                is_pro: true
              }
            );
          } catch (_) {}
        }

        return json({
          user: publicUser(
            account,
            telegramUser
          )
        });
      } catch (error) {
        return json(
          {
            error:
              error.message ||
              'Unauthorized'
          },
          401
        );
      }
    }

    /* ---------------------------------------------------
       PRO STATUS
    --------------------------------------------------- */

    if (
      url.pathname === '/api/pro/status' &&
      request.method === 'POST'
    ) {
      try {
        const body =
          await request.json();

        const telegramUser =
          await validateInitData(
            body.initData,
            env.BOT_TOKEN
          );

        const account =
          await getUser(
            env,
            telegramUser
          );

        return json({
          isPro:
            String(telegramUser.id) ===
              CONFIG.ADMIN_TELEGRAM_ID ||
            Boolean(account?.is_pro) ||
            Boolean(account?.isPro)
        });
      } catch (error) {
        return json(
          {
            error:
              error.message ||
              'Unauthorized'
          },
          401
        );
      }
    }

    /* ---------------------------------------------------
       CREATE TELEGRAM STARS INVOICE
    --------------------------------------------------- */

    if (
      url.pathname === '/api/create-invoice' &&
      request.method === 'POST'
    ) {
      try {
        const body =
          await request.json();

        const telegramUser =
          await validateInitData(
            body.initData,
            env.BOT_TOKEN
          );

        const account =
          await getUser(
            env,
            telegramUser
          );

        const isPro =
          String(telegramUser.id) ===
            CONFIG.ADMIN_TELEGRAM_ID ||
          Boolean(account?.is_pro) ||
          Boolean(account?.isPro);

        if (isPro) {
          return json({
            alreadyPro: true
          });
        }

        const payload =
          `ayahquiz_pro_${telegramUser.id}`;

        const invoiceLink =
          await telegramApi(
            env,
            'createInvoiceLink',
            {
              title:
                'Ayah Quest Pro',
              description:
                'Unlimited Quran practice and advanced revision features.',
              payload,
              currency: 'XTR',
              prices: [
                {
                  label:
                    'Ayah Quest Pro',
                  amount:
                    CONFIG.PRO_STARS
                }
              ]
            }
          );

        return json({
          invoiceLink
        });
      } catch (error) {
        console.error(
          'create-invoice:',
          error
        );

        return json(
          {
            error:
              'Could not create Telegram Stars invoice.'
          },
          500
        );
      }
    }

    /* ---------------------------------------------------
       TELEBIRR REQUEST
    --------------------------------------------------- */

    if (
      url.pathname === '/api/pro/telebirr' &&
      request.method === 'POST'
    ) {
      try {
        const body =
          await request.json();

        const telegramUser =
          await validateInitData(
            body.initData,
            env.BOT_TOKEN
          );

        const reference =
          String(
            body.reference || ''
          ).trim();

        if (
          !reference ||
          reference.length < 3 ||
          reference.length > 100
        ) {
          return json(
            {
              error:
                'Enter a valid Telebirr transaction/reference ID.'
            },
            400
          );
        }

        const id =
          String(telegramUser.id);

        try {
          await updateUser(
            env,
            telegramUser,
            {
              telebirr_reference:
                reference,
              telebirr_amount:
                CONFIG.TELEBIRR_ETB,
              telebirr_phone:
                CONFIG.TELEBIRR_NUMBER,
              telebirr_name:
                CONFIG.TELEBIRR_NAME,
              telebirr_status:
                'pending',
              telebirr_submitted_at:
                new Date().toISOString()
            }
          );
        } catch (error) {
          console.error(
            'Telebirr DB error:',
            error
          );
        }

        await telegramApi(
          env,
          'sendMessage',
          {
            chat_id:
              CONFIG.ADMIN_TELEGRAM_ID,
            text:
              '🧾 <b>New Ayah Quest Pro — Telebirr request</b>\n\n' +
              `User ID: <code>${id}</code>\n` +
              `Name: ${escapeTelegram(
                [telegramUser.first_name, telegramUser.last_name]
                  .filter(Boolean)
                  .join(' ')
              )}\n` +
              `Username: ${
                telegramUser.username
                  ? '@' +
                    escapeTelegram(
                      telegramUser.username
                    )
                  : 'none'
              }\n` +
              `Amount: <b>${CONFIG.TELEBIRR_ETB} ETB</b>\n` +
              `Reference: <code>${escapeTelegram(
                reference
              )}</code>`,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Approve',
                    callback_data:
                      `tb_approve_${id}`
                  },
                  {
                    text: '❌ Reject',
                    callback_data:
                      `tb_reject_${id}`
                  }
                ]
              ]
            }
          }
        );

        return json({
          ok: true
        });
      } catch (error) {
        return json(
          {
            error:
              error.message ||
              'Could not submit Telebirr request.'
          },
          500
        );
      }
    }

    /* ---------------------------------------------------
       QUIZ RESULT
    --------------------------------------------------- */

    if (
      url.pathname === '/api/quiz-result' &&
      request.method === 'POST'
    ) {
      try {
        const body =
          await request.json();

        const telegramUser =
          await validateInitData(
            body.initData,
            env.BOT_TOKEN
          );

        const result = {
          telegram_id:
            String(telegramUser.id),
          global_number:
            body.globalNumber ??
            body.ayahNumber ??
            null,
          correct:
            Boolean(body.correct),
          selected:
            body.selected ?? null,
          created_at:
            new Date().toISOString()
        };

        try {
          await supabase(
            env,
            'quiz_results',
            {
              method: 'POST',
              body: result
            }
          );
        } catch (_) {
          /*
            Quiz results are supplementary.
            Do not break the Mini App if the
            optional table does not exist.
          */
        }

        return json({
          ok: true
        });
      } catch (error) {
        return json(
          {
            error:
              error.message ||
              'Could not save quiz result.'
          },
          401
        );
      }
    }

    return json(
      {
        error: 'Not found'
      },
      404
    );
  }
};