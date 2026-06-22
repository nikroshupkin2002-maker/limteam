const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Инициализация бота и Supabase
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const departmentGroups = {
  "Группа (Аутлет, Обувь, Альпинизм)": ["Аутлет", "Обувь", "Альпинизм"],
  "Группа (Центр, Одежда, Плавание)": ["Центр", "Одежда", "Плавание"],
  "Велосипедный отдел": ["Вело"]
};

const allDepartments = ["Аутлет", "Альпинизм", "Обувь", "Центр", "Одежда", "Плавание", "Вело"];
const daysOfWeek = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

// Генерация временных слотов (Завтрак 10-12 по 15 мин, Обед 12-18 по 30 мин)
const generateTimeSlots = () => {
  const slots = [];
  let h = 10, m = 0;
  while (h < 12) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 15; if (m >= 60) { m = 0; h++; }
    slots.push(`${startTime} (Завтрак)`);
  }
  h = 12; m = 0;
  while (h < 18) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 30; if (m >= 60) { m = 0; h++; }
    slots.push(`${startTime} (Обед)`);
  }
  return slots;
};
const timeSlots = generateTimeSlots();

// Главное меню
const getMainMenu = () => {
  return Markup.keyboard([
    ['📊 Посмотреть все отделы', '📅 Дежурные на неделю'],
    ['🙋 Забронировать место', '❌ Отменить мою бронь']
  ]).resize();
};

const formatTelegramName = (from) => {
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';
  return firstName && lastName ? `${firstName} ${lastName.charAt(0)}.` : (firstName || `User_${from.id}`);
};

// Функция массовой рассылки уведомлений всем пользователям бота
const notifyAllUsers = async (textMessage, excludeUserId) => {
  // Вытаскиваем все ID пользователей из Supabase
  const { data: users } = await supabase.from('users').select('id');
  if (!users) return;

  for (const user of users) {
    if (user.id === excludeUserId) continue; // Пропускаем автора изменений
    try {
      await bot.telegram.sendMessage(user.id, textMessage, { parse_mode: 'Markdown' });
    } catch (err) {
      console.log(`Ошибка отправки пользователю ${user.id}:`, err.message);
    }
  }
};

// Старт бота
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const { data: user } = await supabase.from('users').select('name').eq('id', userId).single();

  if (user) {
    ctx.reply(`Рад видеть вас снова, ${user.name}!`, getMainMenu());
  } else {
    ctx.reply(
      'Привет! Для работы с ботом необходимо зафиксировать Ваше имя в системе.',
      Markup.inlineKeyboard([[Markup.button.callback('👤 Зарегистрироваться через Telegram', 'auto_register')]])
    );
  }
});

// Регистрация в Supabase
bot.action('auto_register', async (ctx) => {
  const userId = ctx.from.id;
  const formattedName = formatTelegramName(ctx.from);

  await supabase.from('users').upsert({ id: userId, name: formattedName });

  ctx.answerCbQuery('Регистрация успешна! 🎉');
  ctx.editMessageText(`Вы зарегистрированы как: *${formattedName}*.`, { parse_mode: 'Markdown' });
  ctx.reply('Используйте меню ниже:', getMainMenu());
});

// Просмотр расписания
bot.hears('📊 Посмотреть все отделы', async (ctx) => {
  const { data: dbBookings } = await supabase.from('bookings').select('*');
  let response = '📋 *Текущая очередь по отделам:*\n\n';

  for (const [groupName, deps] of Object.entries(departmentGroups)) {
    response += `📦 *${groupName.toUpperCase()}*\n— — — — — — — — — — — — —\n`;
    
    timeSlots.forEach(slot => {
      let slotHasBookings = false;
      let slotText = `⏰ *${slot.split(' ')[0]}*:\n`;
      
      deps.forEach(dep => {
        const matches = dbBookings?.filter(b => b.department === dep && b.time_slot === slot) || [];
        if (matches.length > 0) {
          slotHasBookings = true;
          matches.forEach(b => { slotText += `  └ *${dep}*: ${b.user_name}\n`; });
        }
      });
      if (slotHasBookings) response += slotText;
    });
    response += '\n';
  }
  ctx.replyWithMarkdown(response || "Пока броней нет.");
});

// Просмотр дежурных на неделю
bot.hears('📅 Дежурные на неделю', async (ctx) => {
  const { data: duties } = await supabase.from('duty').select('*');
  let text = '📋 *График дежурных на неделю:*\n\n';
  const buttons = [];

  daysOfWeek.forEach(day => {
    const d = duties?.find(item => item.day_of_week === day);
    const name = d && d.duty_name ? d.duty_name : 'Не назначен 🤷‍♂️';
    text += `🔹 *${day}*: ${name}\n`;
    buttons.push([Markup.button.callback(`Изменить ${day}`, `edit_duty_${day}`)]);
  });

  ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
});

// Смена дежурного + автоуведомление всей команды
bot.action(/^edit_duty_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const userId = ctx.from.id;
  
  const { data: user } = await supabase.from('users').select('name').eq('id', userId).single();
  const savedName = user ? user.name : formatTelegramName(ctx.from);

  // Обновляем запись в Supabase
  await supabase.from('duty').update({ duty_name: savedName }).eq('day_of_week', day);

  ctx.answerCbQuery(`Вы назначены дежурным на ${day}!`);
  ctx.editMessageText(`Вы успешно записались дежурным на *${day}*! Команда получила уведомление.`, { parse_mode: 'Markdown' });

  // Массовая рассылка «мозгами» бота по таблице пользователей
  await notifyAllUsers(`🔔 *Обновление графика!* \n\n👤 *${savedName}* назначен дежурным на *${day}*.`, userId);
});

// Шаг 1 бронирования: выбор отдела
bot.hears('🙋 Забронировать место', async (ctx) => {
  const userId = ctx.from.id;
  const { data: user } = await supabase.from('users').select('name').eq('id', userId).single();
  if (!user) return ctx.reply('Сначала зарегистрируйтесь!');

  const buttons = allDepartments.map(dep => [Markup.button.callback(dep, `select_dep_${dep}`)]);
  ctx.reply('Выберите ваш отдел:', Markup.inlineKeyboard(buttons));
});

// Шаг 2 бронирования: выбор времени
bot.action(/^select_dep_(.+)$/, (ctx) => {
  const dep = ctx.match[1];
  const buttons = [];
  for (let i = 0; i < timeSlots.length; i += 3) {
    const row = [Markup.button.callback(timeSlots[i].split(' ')[0], `book_${dep}_${i}`)];
    if (timeSlots[i+1]) row.push(Markup.button.callback(timeSlots[i+1].split(' ')[0], `book_${dep}_${i+1}`));
    if (timeSlots[i+2]) row.push(Markup.button.callback(timeSlots[i+2].split(' ')[0], `book_${dep}_${i+2}`));
    buttons.push(row);
  }
  ctx.editMessageText(`Отдел *${dep}*. Выберите время:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Шаг 3 бронирования: запись
bot.action(/^book_(.+)_(.+)$/, async (ctx) => {
  const dep = ctx.match[1];
  const slotIndex = parseInt(ctx.match[2]);
  const slot = timeSlots[slotIndex];
  const userId = ctx.from.id;

  const { data: user = null } = await supabase.from('users').select('name').eq('id', userId).single();
  const userName = user ? user.name : formatTelegramName(ctx.from);

  // Проверяем, не занято ли уже это время кем-то другим в этом отделе
  const { data: checkDep } = await supabase.from('bookings').select('*').eq('department', dep).eq('time_slot', slot);
  if (checkDep && checkDep.length > 0) {
    return ctx.answerCbQuery(`Слот уже занят сотрудником ${checkDep[0].user_name}!`, { show_alert: true });
  }

  // Удаляем старые записи этого пользователя только в ЭТОМ отделе
  await supabase.from('bookings').delete().eq('user_id', userId).eq('department', dep);

  // Добавляем новую бронь
  await supabase.from('bookings').insert({ user_id: userId, department: dep, time_slot: slot, user_name: userName });

  ctx.answerCbQuery(`Успешно записаны! 🎉`);
  ctx.editMessageText(`Вы записаны в отдел *${dep}* на *${slot}*.`, { parse_mode: 'Markdown' });
});

// Отмена броней
bot.hears('❌ Отменить мою бронь', async (ctx) => {
  const userId = ctx.from.id;
  const { error } = await supabase.from('bookings').delete().eq('user_id', userId);

  if (!error) {
    ctx.reply('Все ваши бронирования во всех отделах успешно отменены.', getMainMenu());
  } else {
    ctx.reply('Активных броней не найдено.', getMainMenu());
  }
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Бот на Supabase готов!');
    }
  } catch (error) {
    console.error(error);
    res.status(500).send('Ошибка сервера');
  }
};
 
