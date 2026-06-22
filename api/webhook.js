const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Инициализация бота и Supabase через переменные окружения Vercel
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
    slots.push(`${startTime} (Завтрак)`);
    m += 15; if (m >= 60) { m = 0; h++; }
  }
  h = 12; m = 0;
  while (h < 18) {
    let startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    slots.push(`${startTime} (Обед)`);
    m += 30; if (m >= 60) { m = 0; h++; }
  }
  return slots;
};
const timeSlots = generateTimeSlots();

// Главное меню бота
const getMainMenu = () => {
  return Markup.keyboard([
    ['📊 Посмотреть все отделы', '📅 Дежурные на неделю'],
    ['🙋 Забронировать место', '❌ Отменить мою бронь']
  ]).resize();
};

// Красивое форматирование имени из Telegram в "Имя Ф."
const formatTelegramName = (from) => {
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';
  return firstName && lastName ? `${firstName} ${lastName.charAt(0)}.` : (firstName || `User_${from.id}`);
};

// Проверка: является ли пользователь админом или старшим
const isStaff = (role) => {
  return role === 'admin' || role === 'manager';
};

// Команда /start
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const { data: user } = await supabase.from('users').select('name, role').eq('id', userId).maybeSingle();

  if (user) {
    let welcomeText = `Рад видеть вас снова, ${user.name}!`;
    if (isStaff(user.role)) welcomeText += ` 👑 (Режим управления сотрудниками)`;
    ctx.reply(welcomeText, getMainMenu());
  } else {
    ctx.reply(
      'Привет! Для работы с ботом необходимо зафиксировать Ваше имя в системе.',
      Markup.inlineKeyboard([[Markup.button.callback('👤 Зарегистрироваться через Telegram', 'auto_register')]])
    );
  }
});

// Автоматическая регистрация
bot.action('auto_register', async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const formattedName = formatTelegramName(ctx.from);

  const { data: existingUser } = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
  if (existingUser) {
    ctx.answerCbQuery('Вы уже зарегистрированы!');
    return ctx.reply('Вы уже в системе.', getMainMenu());
  }

  const { error } = await supabase.from('users').insert({ id: userId, name: formattedName, role: 'user' });
  if (error) return ctx.reply(`Ошибка регистрации: ${error.message}`);

  ctx.answerCbQuery('Регистрация успешна! 🎉');
  ctx.editMessageText(`Вы зарегистрированы как: *${formattedName}*.`, { parse_mode: 'Markdown' });
  ctx.reply('Используйте меню ниже:', getMainMenu());
});

// Просмотр расписания обедов по всем отделам
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
  ctx.replyWithMarkdown(response);
});

// Просмотр дежурных на неделю с разделением по отделам
bot.hears('📅 Дежурные на неделю', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  const { data: duties } = await supabase.from('duty').select('*');

  let text = '📋 *График дежурных на неделю (по отделам):*\n\n';
  
  daysOfWeek.forEach(day => {
    text += `📅 *${day}:*\n`;
    const dayDuties = duties?.filter(d => d.day_of_week === day) || [];
    
    allDepartments.forEach(dep => {
      const dutyForDep = dayDuties.find(d => d.department === dep);
      const name = dutyForDep ? dutyForDep.duty_name : 'Не назначен 🤷‍♂️';
      text += `  └ *${dep}*: ${name}\n`;
    });
    text += '\n';
  });

  // Кнопки настроек видят только админы и менеджеры
  if (me && isStaff(me.role)) {
    const buttons = daysOfWeek.map(day => [Markup.button.callback(`⚙️ Назначить дежурных: ${day}`, `staff_day_${day}`)]);
    ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  } else {
    ctx.replyWithMarkdown(text);
  }
});

// Админ: Выбор отдела для назначения
bot.action(/^staff_day_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const buttons = allDepartments.map(dep => [Markup.button.callback(`Отдел: ${dep}`, `staff_dep_${day}_${dep}`)]);
  ctx.editMessageText(`Управление дежурными на *${day}*.\nВыберите отдел для назначения:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Админ: Выбор сотрудника из списка зарегистрированных в боте
bot.action(/^staff_dep_(.+)_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const dep = ctx.match[2];

  const { data: allUsers } = await supabase.from('users').select('id, name');
  
  if (!allUsers || allUsers.length === 0) {
    return ctx.answerCbQuery('Нет зарегистрированных сотрудников в базе!', { show_alert: true });
  }

  const buttons = allUsers.map(u => [Markup.button.callback(u.name, `assign_duty_${day}_${dep}_${u.id}`)]);
  buttons.push([Markup.button.callback('❌ Сбросить дежурного', `assign_duty_${day}_${dep}_clear`)]);

  ctx.editMessageText(`Назначаем дежурного в отдел *${dep}* на *${day}*.\nВыберите сотрудника:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Админ: Фиксация дежурного в таблице duty
bot.action(/^assign_duty_(.+)_(.+)_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const dep = ctx.match[2];
  const targetUserId = ctx.match[3];

  // Сбрасываем старого дежурного на этот день для этого отдела
  await supabase.from('duty').delete().eq('day_of_week', day).eq('department', dep);

  if (targetUserId === 'clear') {
    ctx.answerCbQuery('Дежурный сброшен');
    return ctx.editMessageText(`Дежурный на *${day}* в отделе *${dep}* успешно сброшен.`, { parse_mode: 'Markdown' });
  }

  const { data: targetUser } = await supabase.from('users').select('name').eq('id', targetUserId).maybeSingle();
  if (!targetUser) return ctx.answerCbQuery('Пользователь не найден');

  // Добавляем запись о дежурном
  await supabase.from('duty').insert({
    day_of_week: day,
    department: dep,
    duty_name: targetUser.name,
    user_id: targetUserId
  });

  ctx.answerCbQuery(`Назначен: ${targetUser.name}`);
  ctx.editMessageText(`На *${day}* в отдел *${dep}* дежурным успешно назначен *${targetUser.name}*!`, { parse_mode: 'Markdown' });
  
  // Мгновенный пуш назначенному сотруднику
  try {
    await bot.telegram.sendMessage(targetUserId, `🔔 Вас назначили дежурным на *${day}* в отдел *${dep}*!`, { parse_mode: 'Markdown' });
  } catch (e) {}
});

// Бронирование места (Шаг 1: выбор отдела)
bot.hears('🙋 Забронировать место', async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const { data: user } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
  if (!user) return ctx.reply('Сначала зарегистрируйтесь!');

  const buttons = allDepartments.map(dep => [Markup.button.callback(dep, `select_dep_${dep}`)]);
  ctx.reply('Выберите ваш отдел:', Markup.inlineKeyboard(buttons));
});

// Бронирование места (Шаг 2: выбор времени)
bot.action(/^select_dep_(.+)$/, (ctx) => {
  const dep = ctx.match[1];
  const buttons = [];
  for (let i = 0; i < timeSlots.length; i += 3) {
    const row = [Markup.button.callback(timeSlots[i].split(' ')[0], `book_${dep}_${i}`)];
    if (timeSlots[i+1]) row.push(Markup.button.callback(timeSlots[i+1].split(' ')[0], `book_${dep}_${i+1}`));
    if (timeSlots[i+2]) row.push(Markup.button.callback(timeSlots[i+2].split(' ')[0], `book_${dep}_${i+2}`));
    buttons.push(row);
  }
  ctx.editMessageText(`Отдел *${dep}*. Выберите время для обеда/завтрака:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Бронирование места (Шаг 3: запись)
bot.action(/^book_(.+)_(.+)$/, async (ctx) => {
  const dep = ctx.match[1];
  const slotIndex = parseInt(ctx.match[2]);
  const slot = timeSlots[slotIndex];
  const userId = ctx.from.id.toString(); 

  const { data: user } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
  const userName = user ? user.name : formatTelegramName(ctx.from);

  // Валидация: свободен ли слот в этом отделе
  const { data: checkDep } = await supabase.from('bookings').select('*').eq('department', dep).eq('time_slot', slot);
  if (checkDep && checkDep.length > 0) {
    return ctx.answerCbQuery(`Слот уже занят сотрудником ${checkDep[0].user_name}!`, { show_alert: true });
  }

  // Перезаписываем бронь юзера в этом отделе
  await supabase.from('bookings').delete().eq('user_id', userId).eq('department', dep);
  await supabase.from('bookings').insert({ user_id: userId, department: dep, time_slot: slot, user_name: userName });

  ctx.answerCbQuery(`Успешно записаны! 🎉`);
  ctx.editMessageText(`Вы записаны в отдел *${dep}* на *${slot}*.`, { parse_mode: 'Markdown' });
});

// Отмена бронирований
bot.hears('❌ Отменить мою бронь', async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const { error } = await supabase.from('bookings').delete().eq('user_id', userId);
  ctx.reply(error ? 'Активных броней не найдено.' : 'Все ваши бронирования во всех отделах успешно отменены.', getMainMenu());
});


// ==========================================
// ОБЪЕДИНЕННЫЙ И ОПТИМИЗИРОВАННЫЙ ПЛАНИРОВЩИК
// ==========================================

const handleUnifiedCron = async () => {
  // Высчитываем текущий час и день по Алматы (UTC+5)
  const ALMATY_HOUR = new Date(Date.now() + 5 * 60 * 60 * 1000).getHours(); 
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  const todayName = days[new Date(Date.now() + 5 * 60 * 60 * 1000).getDay()];

  // 1. УТРЕННЕЕ НАПОМИНАНИЕ ДЕЖУРНЫМ (Срабатывает ровно в 09:00 по Алматы)
  if (ALMATY_HOUR === 9) {
    const { data: todayDuties } = await supabase.from('duty').select('*').eq('day_of_week', todayName);
    if (todayDuties && todayDuties.length > 0) {
      for (const duty of todayDuties) {
        try {
          await bot.telegram.sendMessage(
            duty.user_id, 
            `☀️ *Доброе утро!* Напоминаем, что сегодня ты назначен дежурным в отдел *${duty.department}*. Удачной смены!`, 
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
    }
  }

  // 2. УВЕДОМЛЕНИЕ ОБ ОБЕДАХ ЗА 15 МИНУТ
  // Так как крон запускается на стыке часа (в 00 минут), он ищет все слоты, которые начнутся в :15 минут этого часа
  const { data: allBookings } = await supabase.from('bookings').select('*');
  if (allBookings && allBookings.length > 0) {
    const nextHourStr = String(ALMATY_HOUR).padStart(2, '0');
    const matchingBookings = allBookings.filter(b => b.time_slot.startsWith(`${nextHourStr}:15`));

    for (const booking of matchingBookings) {
      try {
        await bot.telegram.sendMessage(
          booking.user_id,
          `⏳ *Напоминание за 15 минут!* Скоро твое время обеда/завтрака:\n📍 Отдел: *${booking.department}*\n⏰ Время: *${booking.time_slot}*`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {}
    }
  }
};

// Главный обработчик сервера Vercel
module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } 
    // Запуск по Cron-планировщику раз в час
    else if (req.query.cron === 'check') {
      await handleUnifiedCron();
      res.status(200).send('Unified cron executed successfully');
    } 
    else {
      res.status(200).send('Бот на Supabase работает стабильно!');
    }
  } catch (error) {
    console.error('Ошибка обработки:', error);
    res.status(500).send('Внутренняя ошибка сервера');
  }
};
 
