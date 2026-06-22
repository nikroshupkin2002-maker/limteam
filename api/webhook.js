const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Хранилище пользователей (в памяти)
// Структура: { userId: "Имя Фамилия" }
let usersDatabase = {};

// Списки отделов по группам для отображения
const departmentGroups = {
  "Группа (Аутлет, Обувь, Альпинизм)": ["Аутлет", "Обувь", "Альпинизм"],
  "Группа (Центр, Одежда, Плавание)": ["Центр", "Одежда", "Плавание"],
  "Велосипедный отдел": ["Вело"]
};

const allDepartments = ["Аутлет", "Альпинизм", "Обувь", "Центр", "Одежда", "Плавание", "Вело"];

// Генерируем слоты времени
// Завтрак: 10:00 - 12:00 (15 мин), Обед: 12:00 - 18:00 (30 мин)
const generateTimeSlots = () => {
  const slots = [];
  
  // Завтраки (10:00 - 12:00) по 15 минут
  let h = 10, m = 0;
  while (h < 12) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 15;
    if (m >= 60) { m = 0; h++; }
    let endTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    slots.push(`${startTime} - ${endTime} (Завтрак)`);
  }
  
  // Обеды (12:00 - 18:00) по 30 минут
  h = 12; m = 0;
  while (h < 18) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 30;
    if (m >= 60) { m = 0; h++; }
    let endTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    slots.push(`${startTime} - ${endTime} (Обед)`);
  }
  return slots;
};

const timeSlots = generateTimeSlots();

// Структура броней: { "Аутлет": { "10:00 - 10:15 (Завтрак)": [ {id, name} ] } }
let bookings = {};
allDepartments.forEach(dep => {
  bookings[dep] = {};
  timeSlots.forEach(slot => {
    bookings[dep][slot] = [];
  });
});

// Состояние ожидания ввода имени { userId: true }
let awaitingName = {};

// Главное меню
const getMainMenu = () => {
  return Markup.keyboard([
    ['📊 Посмотреть все отделы', '🙋 Забронировать место'],
    ['❌ Отменить мою бронь']
  ]).resize();
};

// Команда /start
bot.start((ctx) => {
  const userId = ctx.from.id;
  
  if (usersDatabase[userId]) {
    ctx.reply(`Рад видеть вас снова, ${usersDatabase[userId]}! Чем могу помочь?`, getMainMenu());
  } else {
    ctx.reply('Привет! Для работы с ботом необходимо зарегистрироваться.\n\nКак Вас зовут? Введите, пожалуйста, Ваши *Имя и Фамилию*:', { parse_mode: 'Markdown' });
    awaitingName[userId] = true;
  }
});

// Просмотр занятых позиций по связанным группам
bot.hears('📊 Посмотреть все отделы', (ctx) => {
  let response = '📋 *Текущая очередь по отделам:*\n\n';

  for (const [groupName, deps] of Object.entries(departmentGroups)) {
    response += `📦 *${groupName.toUpperCase()}*\n`;
    response += `— — — — — — — — — — — — —\n`;
    
    // Для каждого слота времени проверяем запись в отделах этой группы
    timeSlots.forEach(slot => {
      let slotHasBookings = false;
      let slotText = `⏰ *${slot.split(' ')[0]}*:\n`; // Только время, без слова Завтрак/Обед для компактности
      
      deps.forEach(dep => {
        const users = bookings[dep][slot] || [];
        if (users.length > 0) {
          slotHasBookings = true;
          users.forEach(user => {
            slotText += `  └ *${dep}*: ${user.name}\n`;
          });
        }
      });
      
      if (slotHasBookings) {
        response += slotText;
      }
    });
    response += '\n';
  }

  ctx.replyWithMarkdown(response || "Пока никто ничего не забронировал.");
});

// Шаг 1 бронирования: выбор отдела
bot.hears('🙋 Забронировать место', (ctx) => {
  const userId = ctx.from.id;
  if (!usersDatabase[userId]) {
    return ctx.reply('Сначала введите ваше Имя и Фамилию для регистрации!');
  }

  const buttons = allDepartments.map(dep => [Markup.button.callback(dep, `select_dep_${dep}`)]);
  ctx.reply('Выберите ваш отдел:', Markup.inlineKeyboard(buttons));
});

// Шаг 2 бронирования: выбор времени внутри отдела
bot.action(/^select_dep_(.+)$/, (ctx) => {
  const dep = ctx.match[1];
  
  // Генерируем кнопки времени (по 2 в ряд для компактности)
  const buttons = [];
  for (let i = 0; i < timeSlots.length; i += 2) {
    const row = [Markup.button.callback(timeSlots[i].split(' ')[0], `book_${dep}_${i}`)];
    if (timeSlots[i+1]) {
      row.push(Markup.button.callback(timeSlots[i+1].split(' ')[0], `book_${dep}_${i+1}`));
    }
    buttons.push(row);
  }
  
  ctx.editMessageText(`Вы выбрали отдел *${dep}*.\nТеперь выберите удобное время:`, {
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
  const userSavedName = usersDatabase[userId] || ctx.from.first_name;

  // Проверка на дубликат в ЭТОМ ЖЕ отделе на ЭТО ЖЕ время
  if (bookings[dep][slot].some(u => u.id === userId)) {
    return ctx.answerCbQuery('Вы уже записаны на это время в данном отделе! 🤨', { show_alert: true });
  }

  // Удаляем старые записи пользователя в ЭТОМ отделе (чтобы не занимал много слотов сразу)
  timeSlots.forEach(s => {
    bookings[dep][s] = bookings[dep][s].filter(u => u.id !== userId);
  });

  // Записываем
  bookings[dep][slot].push({ id: userId, name: userSavedName });

  ctx.answerCbQuery(`Успешно записаны на ${slot.split(' ')[0]}! 🎉`);
  ctx.editMessageText(`Отлично! Вы записаны в отдел *${dep}* на время *${slot}*.\nПроверить общую очередь можно через меню.`, { parse_mode: 'Markdown' });
});

// Отмена брони (удаляет записи пользователя из всех отделов)
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
    ctx.reply('Ваши бронирования во всех отделах успешно отменены.', getMainMenu());
  } else {
    ctx.reply('У вас не было активных броней.', getMainMenu());
  }
});

// Текстовый обработчик для перехвата Имени и Фамилии при регистрации
bot.on('text', (ctx) => {
  const userId = ctx.from.id;

  if (awaitingName[userId]) {
    const fullName = ctx.message.text.trim();
    
    // Простая валидация, что ввели хотя бы два слова
    if (fullName.split(' ').length < 2) {
      return ctx.reply('Пожалуйста, введите и *Имя*, и *Фамилию* через пробел:');
    }

    usersDatabase[userId] = fullName;
    delete awaitingName[userId];

    ctx.reply(`Успешно! Вы зарегистрированы как: *${fullName}*.\nТеперь вы можете пользоваться расписанием.`, getMainMenu({ parse_mode: 'Markdown' }));
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Бот отделов обедов работает!');
    }
  } catch (error) {
    console.error(error);
    res.status(500).send('Ошибка');
  }
};
