const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// База данных пользователей в памяти
let usersDatabase = {};

// Группировка для вывода занятых позиций
const departmentGroups = {
  "Группа (Аутлет, Обувь, Альпинизм)": ["Аутлет", "Обувь", "Альпинизм"],
  "Группа (Центр, Одежда, Плавание)": ["Центр", "Одежда", "Плавание"],
  "Велосипедный отдел": ["Вело"]
};

// Все доступные отделы
const allDepartments = ["Аутлет", "Альпинизм", "Обувь", "Центр", "Одежда", "Плавание", "Вело"];

// Генерация временных слотов (Завтрак 10-12 по 15 мин, Обед 12-18 по 30 мин)
const generateTimeSlots = () => {
  const slots = [];
  let h = 10, m = 0;
  while (h < 12) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 15;
    if (m >= 60) { m = 0; h++; }
    slots.push(`${startTime} (Завтрак)`);
  }
  h = 12; m = 0;
  while (h < 18) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 30;
    if (m >= 60) { m = 0; h++; }
    slots.push(`${startTime} (Обед)`);
  }
  return slots;
};

const timeSlots = generateTimeSlots();

// Инициализация структуры бронирований
let bookings = {};
allDepartments.forEach(dep => {
  bookings[dep] = {};
  timeSlots.forEach(slot => { bookings[dep][slot] = []; });
});

// Главное меню бота
const getMainMenu = () => {
  return Markup.keyboard([
    ['📊 Посмотреть все отделы'],
    ['🙋 Забронировать место', '❌ Отменить мою бронь']
  ]).resize();
};

// Функция для форматирования имени в формат "Имя Ф."
const formatTelegramName = (from) => {
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';
  
  if (firstName && lastName) {
    return `${firstName} ${lastName.charAt(0)}.`;
  } else if (firstName) {
    return firstName;
  } else {
    return from.username ? `@${from.username}` : `User_${from.id}`;
  }
};

// Команда /start
bot.start((ctx) => {
  const userId = ctx.from.id;
  
  if (usersDatabase[userId]) {
    ctx.reply(`Рад видеть вас снова, ${usersDatabase[userId]}!`, getMainMenu());
  } else {
    // Предлагаем кнопку для автоматической регистрации по данным TG
    ctx.reply(
      'Привет! Для работы с ботом необходимо зафиксировать Ваше имя в системе.',
      Markup.inlineKeyboard([
        [Markup.button.callback('👤 Зарегистрироваться под своим именем', 'auto_register')]
      ])
    );
  }
});

// Обработка автоматической регистрации
bot.action('auto_register', (ctx) => {
  const userId = ctx.from.id;
  const formattedName = formatTelegramName(ctx.from);
  
  usersDatabase[userId] = formattedName;
  
  ctx.answerCbQuery('Регистрация успешна! 🎉');
  ctx.editMessageText(`Отлично! Вы зарегистрированы как: *${formattedName}*.\nТеперь вам доступны бронирования.`, { parse_mode: 'Markdown' });
  ctx.reply('Используйте меню ниже:', getMainMenu());
});

// Просмотр расписания по связанным группам отделов
bot.hears('📊 Посмотреть все отделы', (ctx) => {
  let response = '📋 *Текущая очередь по отделам:*\n\n';

  for (const [groupName, deps] of Object.entries(departmentGroups)) {
    response += `📦 *${groupName.toUpperCase()}*\n`;
    response += `— — — — — — — — — — — — —\n`;
    
    timeSlots.forEach(slot => {
      let slotHasBookings = false;
      let slotText = `⏰ *${slot.split(' ')[0]}*:\n`;
      
      deps.forEach(dep => {
        const users = bookings[dep][slot] || [];
        if (users.length > 0) {
          slotHasBookings = true;
          users.forEach(user => {
            slotText += `  └ *${dep}*: ${user.name}\n`;
          });
        }
      });
      
      if (slotHasBookings) response += slotText;
    });
    response += '\n';
  }

  ctx.replyWithMarkdown(response || "Пока броней нет.");
});

// Шаг 1 бронирования: выбор отдела (каждая кнопка на отдельной строке)
bot.hears('🙋 Забронировать место', (ctx) => {
  const userId = ctx.from.id;
  if (!usersDatabase[userId]) {
    return ctx.reply('Сначала нажмите кнопку регистрации в начале диалога!');
  }

  // Создаем массив, где каждый отдел — это отдельный ряд кнопок [строка]
  const buttons = allDepartments.map(dep => [Markup.button.callback(dep, `select_dep_${dep}`)]);
  
  ctx.reply('Выберите ваш отдел:', Markup.inlineKeyboard(buttons));
});

// Шаг 2 бронирования: выбор времени внутри отдела
bot.action(/^select_dep_(.+)$/, (ctx) => {
  const dep = ctx.match[1];
  
  // Кнопки времени делаем по 3 в ряд для компактности прокрутки
  const buttons = [];
  for (let i = 0; i < timeSlots.length; i += 3) {
    const row = [Markup.button.callback(timeSlots[i].split(' ')[0], `book_${dep}_${i}`)];
    if (timeSlots[i+1]) row.push(Markup.button.callback(timeSlots[i+1].split(' ')[0], `book_${dep}_${i+1}`));
    if (timeSlots[i+2]) row.push(Markup.button.callback(timeSlots[i+2].split(' ')[0], `book_${dep}_${i+2}`));
    buttons.push(row);
  }
  
  ctx.editMessageText(`Вы выбрали отдел *${dep}*.\nВыберите удобное время:`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(buttons)
  });
});

// Шаг 3 бронирования: фиксация записи
bot.action(/^book_(.+)_(.+)$/, (ctx) => {
  const dep = ctx.match[1];
  const slotIndex = parseInt(ctx.match[2]);
  const slot = timeSlots[slotIndex];
  const userId = ctx.from.id;
  const userSavedName = usersDatabase[userId] || formatTelegramName(ctx.from);

  if (bookings[dep][slot].some(u => u.id === userId)) {
    return ctx.answerCbQuery('Вы уже записаны на это время здесь! 🤨', { show_alert: true });
  }

  // Сбрасываем прошлые записи человека только в этом конкретном отделе
  timeSlots.forEach(s => {
    bookings[dep][s] = bookings[dep][s].filter(u => u.id !== userId);
  });

  bookings[dep][slot].push({ id: userId, name: userSavedName });

  ctx.answerCbQuery(`Успешно записаны! 🎉`);
  ctx.editMessageText(`Готово! Вы записаны в отдел *${dep}* на время *${slot}*.\nПроверить занятые слоты можно через кнопку «Посмотреть все отделы».`, { parse_mode: 'Markdown' });
});

// Отмена брони
bot.hears('❌ Отменить мою бронь', (ctx) => {
  let found = false;
  const userId = ctx.from.id;

  allDepartments.forEach(dep => {
    timeSlots.forEach(slot => {
      const initialLength = bookings[dep][slot].length;
      bookings[dep][slot] = bookings[dep][slot].filter(u => u.id !== userId);
      if (bookings[dep][slot].length < initialLength) found = true;
    });
  });

  if (found) {
    ctx.reply('Ваша бронь во всех отделах успешно отменена.', getMainMenu());
  } else {
    ctx.reply('Активных броней не найдено.', getMainMenu());
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Бот обновлен!');
    }
  } catch (error) {
    console.error(error);
    res.status(500).send('Ошибка');
  }
};
