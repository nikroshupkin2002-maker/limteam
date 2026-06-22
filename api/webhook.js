const { Telegraf, Markup } = require('telegraf');

// Инициализируем бота через переменную окружения (токен)
const bot = new Telegraf(process.env.BOT_TOKEN);

// Временное хранилище бронирований (сбрасывается при перезапуске сервера)
// В будущем сюда отлично встанет база данных
let bookings = {
  "09:00 - Завтрак": [],
  "09:30 - Завтрак": [],
  "13:00 - Обед": [],
  "13:30 - Обед": [],
  "14:00 - Обед": []
};

// Главное меню
const getMainMenu = () => {
  return Markup.keyboard([
    ['📅 Посмотреть расписание', '🙋 Забронировать очередь'],
    ['❌ Отменить мою бронь']
  ]).resize();
};

// Команда /start
bot.start((ctx) => {
  ctx.reply(
    `Привет, ${ctx.from.first_name}! Я бот для бронирования времени обедов и завтраков. Выберите действие:`,
    getMainMenu()
  );
});

// Просмотр расписания
bot.hears('📅 Посмотреть расписание', (ctx) => {
  let response = '📋 *Текущая очередь:*\n\n';
  
  for (const [time, users] of Object.entries(bookings)) {
    response += `⏰ *${time}*:\n`;
    if (users.length === 0) {
      response += `  — Свободно\n`;
    } else {
      users.forEach((user, index) => {
        response += `  ${index + 1}. ${user.name}\n`;
      });
    }
    response += '\n';
  }
  
  ctx.replyWithMarkdown(response);
});

// Кнопки для выбора времени (Инлайн-кнопки)
bot.hears('🙋 Забронировать очередь', (ctx) => {
  const buttons = Object.keys(bookings).map(time => {
    return [Markup.button.callback(time, `book_${time}`)];
  });
  
  ctx.reply('Выберите удобное время:', Markup.inlineKeyboard(buttons));
});

// Обработка нажатия на кнопку времени
bot.action(/^book_(.+)$/, (ctx) => {
  const selectedTime = ctx.match[1];
  const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  
  // Проверяем, не записан ли уже человек на это время
  if (bookings[selectedTime].some(user => user.id === ctx.from.id)) {
    return ctx.answerCbQuery('Вы уже записаны на это время! 🤔', { show_alert: true });
  }
  
  // Удаляем старые записи пользователя на другие слоты, чтобы не занимал всё подряд
  for (const time in bookings) {
    bookings[time] = bookings[time].filter(user => user.id !== ctx.from.id);
  }
  
  // Добавляем запись
  bookings[selectedTime].push({ id: ctx.from.id, name: userName });
  
  ctx.answerCbQuery(`Вы успешно записались на ${selectedTime}! 🎉`);
  ctx.editMessageText(`Отлично! Вы записаны на *${selectedTime}*.\nПосмотреть общую очередь можно через меню.`, { parse_mode: 'Markdown' });
});

// Отмена брони
bot.hears('❌ Отменить мою бронь', (ctx) => {
  let found = false;
  for (const time in bookings) {
    const initialLength = bookings[time].length;
    bookings[time] = bookings[time].filter(user => user.id !== ctx.from.id);
    if (bookings[time].length < initialLength) {
      found = true;
    }
  }
  
  if (found) {
    ctx.reply('Ваша бронь успешно отменена.', getMainMenu());
  } else {
    ctx.reply('Вы не были никуда записаны.', getMainMenu());
  }
});

// Экспортируем функцию для Vercel Serverless
module.exports = async (req, res) => {
  try {
    // Принимаем только POST запросы от Telegram
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Бот работает! Отправьте POST запрос от Telegram.');
    }
  } catch (error) {
    console.error('Ошибка обработки хука:', error);
    res.status(500).send('Внутренняя ошибка сервера');
  }
};
