const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Группы отделов для очереди обедов
const departmentGroups = {
  "Группа (Аутлет, Обувь, Альпинизм)": ["Аутлет", "Обувь", "Альпинизм"],
  "Группа (Центр, Одежда, Плавание)": ["Центр", "Одежда", "Плавание"],
  "Велосипедный отдел / Касса": ["Вело", "Касса"]
};

// Все существующие отделы системы
const allDepartments = ["Аутлет", "Альпинизм", "Обувь", "Центр", "Одежда", "Плавание", "Вело", "Касса"];
const daysOfWeek = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

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

// Главное меню с новыми кнопками
const getMainMenu = () => {
  return Markup.keyboard([
    ['📊 Посмотреть все отделы', '📅 Дежурные на неделю'],
    ['🔥 Дежурные на сегодня', '📆 График на сегодня'],
    ['📝 График работы на неделю', '🙋 Забронировать место'],
    ['❌ Отменить мою бронь']
  ]).resize();
};

const formatTelegramName = (from) => {
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';
  return firstName && lastName ? `${firstName} ${lastName.charAt(0)}.` : (firstName || `User_${from.id}`);
};

const isStaff = (role) => {
  return role === 'admin' || role === 'manager';
};

const getAlmatyDayName = () => {
  const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
  return days[new Date(Date.now() + 5 * 60 * 60 * 1000).getDay()];
};

// Команда /start
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const { data: user } = await supabase.from('users').select('name, role').eq('id', userId).maybeSingle();

  if (user) {
    let welcomeText = `Рад видеть вас снова, ${user.name}!`;
    if (isStaff(user.role)) welcomeText += ` 👑 (Администратор)`;
    ctx.reply(welcomeText, getMainMenu());
  } else {
    ctx.reply(
      'Привет! Для работы с ботом необходимо зафиксировать Ваше имя в системе.',
      Markup.inlineKeyboard([[Markup.button.callback('👤 Зарегистрироваться через Telegram', 'auto_register')]])
    );
  }
});

bot.action('auto_register', async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const formattedName = formatTelegramName(ctx.from);

  const { data: existingUser } = await supabase.from('users').select('id').eq('id', userId).maybeSingle();
  if (existingUser) return ctx.answerCbQuery('Вы уже зарегистрированы!');

  await supabase.from('users').insert({ id: userId, name: formattedName, role: 'user' });
  ctx.answerCbQuery('Регистрация успешна! 🎉');
  ctx.editMessageText(`Вы зарегистрированы как: *${formattedName}*.`, { parse_mode: 'Markdown' });
  ctx.reply('Используйте меню ниже:', getMainMenu());
});

// 1. ОЧЕРЕДЬ ОБЕДОВ
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

const buildDutiesText = (duties) => {
  let text = '';
  allDepartments.forEach(dep => {
    const dutyForDep = duties?.find(d => d.department === dep);
    const name = dutyForDep ? dutyForDep.duty_name : 'Не назначен 🤷‍♂️';
    text += `  └ *${dep}*: ${name}\n`;
  });
  return text;
};

// 2. ДЕЖУРНЫЕ НА НЕДЕЛЮ
bot.hears('📅 Дежурные на неделю', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  const { data: duties } = await supabase.from('duty').select('*');

  let text = '📋 *График дежурных на неделю (по отделам):*\n\n';
  daysOfWeek.forEach(day => {
    text += `📅 *${day}:*\n`;
    text += buildDutiesText(duties?.filter(d => d.day_of_week === day));
    text += '\n';
  });

  if (me && isStaff(me.role)) {
    const buttons = daysOfWeek.map(day => [Markup.button.callback(`⚙️ Назначить дежурных: ${day}`, `staff_day_${day}`)]);
    ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  } else {
    ctx.replyWithMarkdown(text);
  }
});

// 3. ДЕЖУРНЫЕ НА СЕГОДНЯ
bot.hears('🔥 Дежурные на сегодня', async (ctx) => {
  const today = getAlmatyDayName();
  const { data: todayDuties } = await supabase.from('duty').select('*').eq('day_of_week', today);

  let text = `🔥 *Дежурные сотрудники на СЕГОДНЯ (${today}):*\n\n`;
  text += buildDutiesText(todayDuties);
  ctx.replyWithMarkdown(text);
});

// Вспомогательная функция для сборки текста графика работы
const buildScheduleText = (day, scheduleData) => {
  let text = `📅 *${day}:*\n`;
  const daySchedule = scheduleData?.filter(s => s.day_of_week === day) || [];
  allDepartments.forEach(dep => {
    const workers = daySchedule.filter(s => s.department === dep).map(s => s.user_name).join(', ');
    text += `  └ *${dep}*: ${workers || 'Никто не работает ❌'}\n`;
  });
  return text;
};

// 4. ГРАФИК НА СЕГОДНЯ (Новая кнопка)
bot.hears('📆 График на сегодня', async (ctx) => {
  const today = getAlmatyDayName();
  const { data: scheduleData } = await supabase.from('schedule').select('*').eq('day_of_week', today);

  let text = `📆 *График работы сотрудников на СЕГОДНЯ (${today}):*\n\n`;
  text += buildScheduleText(today, scheduleData);
  ctx.replyWithMarkdown(text);
});

// 5. ПРОСМОТР И УПРАВЛЕНИЕ ГРАФИКОМ НА НЕДЕЛЮ
bot.hears('📝 График работы на неделю', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  const { data: scheduleData } = await supabase.from('schedule').select('*');

  let text = '📝 *Текущий график работы сотрудников на неделю:*\n\n';
  daysOfWeek.forEach(day => {
    text += buildScheduleText(day, scheduleData);
    text += '\n';
  });

  if (me && isStaff(me.role)) {
    const buttons = daysOfWeek.map(day => [Markup.button.callback(`⚙️ Редактировать график: ${day}`, `sched_day_${day}`)]);
    ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  } else {
    ctx.replyWithMarkdown(text);
  }
});


// ==========================================
// ИСПРАВЛЕННАЯ АДМИНКА ГРАФИКА РАБОТЫ
// ==========================================

bot.action(/^sched_day_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const buttons = allDepartments.map(dep => [Markup.button.callback(`Отдел: ${dep}`, `sched_dep_${day}_${dep}`)]);
  ctx.editMessageText(`Редактирование графика на *${day}*.\nВыберите отдел:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Отрендерить меню выбора сотрудников со статусами (кто уже добавлен, а кто нет)
const renderWorkersMenu = async (ctx, day, dep) => {
  const { data: allUsers } = await supabase.from('users').select('id, name');
  const { data: currentWorkers } = await supabase.from('schedule').select('user_id').eq('day_of_week', day).eq('department', dep);
  
  if (!allUsers || allUsers.length === 0) return ctx.answerCbQuery('Нет пользователей в базе');

  const workerIds = currentWorkers?.map(w => w.user_id.toString()) || [];

  const buttons = allUsers.map(u => {
    const isAdded = workerIds.includes(u.id.toString());
    // Если добавлен — показываем галочку, если нет — плюс
    const label = isAdded ? `✅ ${u.name} (В смене)` : `➕ ${u.name}`;
    return [Markup.button.callback(label, `sched_toggle_${day}_${dep}_${u.id}`)];
  });

  buttons.push([Markup.button.callback('⬅️ Назад к отделам', `sched_day_${day}`)]);
  
  await ctx.editMessageText(
    `Управление сменами: отдел *${dep}*, день *${day}*.\nНажмите на имя сотрудника, чтобы добавить или удалить его из графика:`, 
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
};

bot.action(/^sched_dep_(.+)_(.+)$/, async (ctx) => {
  await renderWorkersMenu(ctx, ctx.match[1], ctx.match[2]);
});

bot.action(/^sched_toggle_(.+)_(.+)_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const dep = ctx.match[2];
  const targetUserId = ctx.match[3].toString();

  const { data: exist } = await supabase.from('schedule').select('id').eq('day_of_week', day).eq('department', dep).eq('user_id', targetUserId).maybeSingle();

  if (exist) {
    await supabase.from('schedule').delete().eq('id', exist.id);
    ctx.answerCbQuery('Сотрудник удален из графика');
  } else {
    const { data: user } = await supabase.from('users').select('name').eq('id', targetUserId).maybeSingle();
    if (user) {
      await supabase.from('schedule').insert({ user_id: targetUserId, user_name: user.name, day_of_week: day, department: dep });
      ctx.answerCbQuery('Сотрудник добавлен в график 🎉');
    }
  }

  // Мгновенно перерисовываем это же меню со свежими статусами галочек
  await renderWorkersMenu(ctx, day, dep);
});


// ==========================================
// НАЗНАЧЕНИЕ ДЕЖУРНЫХ (СВЯЗАННОЕ С ГРАФИКОМ)
// ==========================================

bot.action(/^staff_day_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const buttons = allDepartments.map(dep => [Markup.button.callback(`Отдел: ${dep}`, `staff_dep_${day}_${dep}`)]);
  ctx.editMessageText(`Управление дежурными на *${day}*.\nВыберите отдел:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^staff_dep_(.+)_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const dep = ctx.match[2];

  const { data: workersToday } = await supabase.from('schedule').select('user_id, user_name').eq('day_of_week', day).eq('department', dep);
  
  if (!workersToday || workersToday.length === 0) {
    const buttons = [[Markup.button.callback('⬅️ Назад к отделам', `staff_day_${day}`)]];
    return ctx.editMessageText(`❌ Нельзя назначить дежурного на *${day}* в отдел *${dep}*.\n\nПо графику работы в этот день в данном отделе *никто не числится*. Сначала заполните график!`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  }

  const buttons = workersToday.map(w => [Markup.button.callback(w.user_name, `assign_duty_${day}_${dep}_${w.user_id}`)]);
  buttons.push([Markup.button.callback('❌ Сбросить дежурного', `assign_duty_${day}_${dep}_clear`)]);
  buttons.push([Markup.button.callback('⬅️ Назад', `staff_day_${day}`)]);

  ctx.editMessageText(`Назначаем дежурного в отдел *${dep}* на *${day}*.\nДоступны только сотрудники, стоящие в смене по графику:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^assign_duty_(.+)_(.+)_(.+)$/, async (ctx) => {
  const day = ctx.match[1];
  const dep = ctx.match[2];
  const targetUserId = ctx.match[3];

  await supabase.from('duty').delete().eq('day_of_week', day).eq('department', dep);

  if (targetUserId === 'clear') {
    ctx.answerCbQuery('Дежурный сброшен');
    return ctx.editMessageText(`Дежурный на *${day}* в отделе *${dep}* успешно сброшен.`, { parse_mode: 'Markdown' });
  }

  const { data: targetUser } = await supabase.from('users').select('name').eq('id', targetUserId).maybeSingle();
  if (!targetUser) return ctx.answerCbQuery('Пользователь не найден');

  await supabase.from('duty').insert({ day_of_week: day, department: dep, duty_name: targetUser.name, user_id: targetUserId });

  ctx.answerCbQuery(`Назначен: ${targetUser.name}`);
  ctx.editMessageText(`На *${day}* в отдел *${dep}* дежурным назначен *${targetUser.name}*!`, { parse_mode: 'Markdown' });
  
  try {
    await bot.telegram.sendMessage(targetUserId, `🔔 Вас назначили дежурным на *${day}* в отдел *${dep}*!`, { parse_mode: 'Markdown' });
  } catch (e) {}
});


// ==========================================
// БРОНИРОВАНИЯ (ОБЕДЫ)
// ==========================================

bot.hears('🙋 Забронировать место', async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const { data: user } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
  if (!user) return ctx.reply('Сначала зарегистрируйтесь!');

  const buttons = allDepartments.map(dep => [Markup.button.callback(dep, `select_dep_${dep}`)]);
  ctx.reply('Выберите ваш отдел:', Markup.inlineKeyboard(buttons));
});

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

bot.action(/^book_(.+)_(.+)$/, async (ctx) => {
  const dep = ctx.match[1];
  const slotIndex = parseInt(ctx.match[2]);
  const slot = timeSlots[slotIndex];
  const userId = ctx.from.id.toString(); 

  const { data: user = formatTelegramName(ctx.from) } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
  const userName = user?.name || user;

  const { data: checkDep } = await supabase.from('bookings').select('*').eq('department', dep).eq('time_slot', slot);
  if (checkDep && checkDep.length > 0) {
    return ctx.answerCbQuery(`Слот уже занят сотрудником ${checkDep[0].user_name}!`, { show_alert: true });
  }

  await supabase.from('bookings').delete().eq('user_id', userId).eq('department', dep);
  await supabase.from('bookings').insert({ user_id: userId, department: dep, time_slot: slot, user_name: userName });

  ctx.answerCbQuery(`Успешно записаны! 🎉`);
  ctx.editMessageText(`Вы записаны в отдел *${dep}* на *${slot}*.`, { parse_mode: 'Markdown' });
});

bot.hears('❌ Отменить мою бронь', async (ctx) => {
  const userId = ctx.from.id.toString(); 
  const { error } = await supabase.from('bookings').delete().eq('user_id', userId);
  ctx.reply(error ? 'Активных броней не найдено.' : 'Все ваши бронирования успешно отменены.', getMainMenu());
});

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      await bot.handleUpdate(req.body, res);
    } else {
      res.status(200).send('Бот на Supabase работает стабильно!');
    }
  } catch (error) {
    console.error('Ошибка обработки:', error);
    res.status(500).send('Внутренняя ошибка сервера');
  }
};
