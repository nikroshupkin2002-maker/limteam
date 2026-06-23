const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// Группы отделов для очереди обедов
const departmentGroups = {
  "Группа (Аутлет, Обувь, Альпинизм)": ["Аутлет", "Обувь", "Альпинизм"],
  "Группа (Центр, Одежда, Плавание)": ["Центр", "Одежда", "Плавание"],
  "Вело": ["Вело"],
  "Касса": ["Касса"]
};

// Все существующие отделы системы
const allDepartments = ["Аутлет", "Альпинизм", "Обувь", "Центр", "Одежда", "Плавание", "Вело", "Касса"];

// Короткие коды отделов для callback_data
const depCodes = { "Аутлет": "d1", "Альпинизм": "d2", "Обувь": "d3", "Центр": "d4", "Одежда": "d5", "Плавание": "d6", "Вело": "d7", "Касса": "d8" };
const depCodesReverse = Object.fromEntries(Object.entries(depCodes).map(([k, v]) => [v, k]));

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
const getMainMenu = (staff = false) => {
  const rows = [
    ['📊 Завтрак и Обед по отделам', '📅 Дежурные на неделю'],
    ['🔥 Дежурные на сегодня', '📆 График на сегодня'],
    ['📝 График работы на неделю', '🙋 Бронь Завтрака и обеда'],
    ['❌ Отменить мою бронь']
  ];
  if (staff) rows.push(['📌 Поставить задачу', '📋 Задачи команды']);
  if (staff) rows.push(['🤖 Написать график текстом']);
  return Markup.keyboard(rows).resize();
};

const formatTelegramName = (from) => {
  const firstName = from.first_name || '';
  const lastName = from.last_name || '';
  return firstName && lastName ? `${firstName} ${lastName.charAt(0)}.` : (firstName || `User_${from.id}`);
};

const isStaff = (role) => {
  return role === 'admin' || role === 'manager';
};

// ==========================================
// РАБОТА С ДАТАМИ (Алматы, UTC+5)
// ==========================================

const dayNamesShort = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const dayNamesFull = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

// Текущая дата/время в Алматы (UTC+5), как объект Date в "псевдо-локальном" сдвиге
const getAlmatyNow = () => new Date(Date.now() + 5 * 60 * 60 * 1000);

// Форматирует Date в строку YYYY-MM-DD (используем только UTC-методы, т.к. getAlmatyNow уже сдвинут на +5)
const formatDateISO = (d) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// Форматирует дату в читаемый вид "29.06"
const formatDateShort = (isoDate) => {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}`;
};

// Возвращает день недели (короткий, "Пн") по ISO-дате
const getDayShortByDate = (isoDate) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  return dayNamesShort[d.getUTCDay()];
};

const getDayFullByDate = (isoDate) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  return dayNamesFull[d.getUTCDay()];
};

// Сегодняшняя дата в Алматы, формат YYYY-MM-DD
const getTodayISO = () => formatDateISO(getAlmatyNow());

// Возвращает массив 7 дат текущей недели (Пн -> Нд) в формате YYYY-MM-DD
const getCurrentWeekDates = () => {
  const now = getAlmatyNow();
  const jsDay = now.getUTCDay(); // 0 = Вс, 1 = Пн, ...
  // Смещение до понедельника этой недели
  const diffToMonday = (jsDay === 0) ? -6 : (1 - jsDay);
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMonday);

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(formatDateISO(d));
  }
  return dates;
};

// Код даты для callback_data: MMDD (компактно, без неоднозначностей в пределах года)
const dateToCode = (isoDate) => isoDate.slice(5).replace('-', ''); // "2026-06-29" -> "0629"
const codeToDate = (code, isoDate) => {
  // Восстанавливаем год из любой даты текущей недели (все даты недели — в одном году, кроме редкого перехода Дек/Янв)
  const year = isoDate.slice(0, 4);
  return `${year}-${code.slice(0, 2)}-${code.slice(2, 4)}`;
};

// Команда /start
bot.start(async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: user, error } = await supabase.from('users').select('name, role').eq('id', userId).maybeSingle();

  if (error) {
    console.error('Ошибка получения пользователя:', error);
    return ctx.reply('⚠️ Не удалось связаться с базой данных. Попробуйте позже.');
  }

  if (user) {
    let welcomeText = `Рад видеть вас снова, ${user.name}!`;
    if (isStaff(user.role)) welcomeText += ` 👑 (Администратор)`;
    ctx.reply(welcomeText, getMainMenu(isStaff(user.role)));
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

  const { error } = await supabase.from('users').insert({ id: userId, name: formattedName, role: 'user' });

  if (error) {
    console.error('Ошибка регистрации:', error);
    return ctx.answerCbQuery('⚠️ Ошибка регистрации. Попробуйте позже.', { show_alert: true });
  }

  ctx.answerCbQuery('Регистрация успешна! 🎉');
  ctx.editMessageText(`Вы зарегистрированы как: *${formattedName}*.`, { parse_mode: 'Markdown' });
  ctx.reply('Используйте меню ниже:', getMainMenu());
});

// 1. ОЧЕРЕДЬ ОБЕДОВ (бронирования не зависят от даты — это очередь на сегодняшний день по смыслу использования)
bot.hears('📊 Завтрак и Обед по отделам', async (ctx) => {
  const { data: dbBookings, error } = await supabase.from('bookings').select('*');

  if (error) {
    console.error('Ошибка получения бронирований:', error);
    return ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
  }

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
    const dutiesForDep = duties?.filter(d => d.department === dep) || [];
    const names = dutiesForDep.length > 0 ? dutiesForDep.map(d => d.duty_name).join(', ') : 'Не назначен 🤷‍♂️';
    text += `  └ *${dep}*: ${names}\n`;
  });
  return text;
};

// 2. ДЕЖУРНЫЕ НА НЕДЕЛЮ (по датам текущей недели)
bot.hears('📅 Дежурные на неделю', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();

  const weekDates = getCurrentWeekDates();
  const { data: duties, error } = await supabase.from('duty').select('*').in('work_date', weekDates);

  if (error) {
    console.error('Ошибка получения дежурных:', error);
    return ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
  }

  let text = '📋 *График дежурных на текущую неделю (по отделам):*\n\n';
  weekDates.forEach(date => {
    text += `📅 *${getDayFullByDate(date)}, ${formatDateShort(date)}:*\n`;
    text += buildDutiesText(duties?.filter(d => d.work_date === date));
    text += '\n';
  });

  if (me && isStaff(me.role)) {
    const buttons = weekDates.map(date => [Markup.button.callback(`⚙️ Назначить дежурных: ${getDayShortByDate(date)} ${formatDateShort(date)}`, `staff_day_${dateToCode(date)}`)]);
    ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  } else {
    ctx.replyWithMarkdown(text);
  }
});

// 3. ДЕЖУРНЫЕ НА СЕГОДНЯ
bot.hears('🔥 Дежурные на сегодня', async (ctx) => {
  const today = getTodayISO();
  const { data: todayDuties, error } = await supabase.from('duty').select('*').eq('work_date', today);

  if (error) {
    console.error('Ошибка получения дежурных на сегодня:', error);
    return ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
  }

  let text = `🔥 *Дежурные сотрудники на СЕГОДНЯ (${getDayFullByDate(today)}, ${formatDateShort(today)}):*\n\n`;
  text += buildDutiesText(todayDuties);
  ctx.replyWithMarkdown(text);
});

// Вспомогательная функция для сборки текста графика работы
const buildScheduleText = (date, scheduleData) => {
  let text = `📅 *${getDayFullByDate(date)}, ${formatDateShort(date)}:*\n`;
  const daySchedule = scheduleData?.filter(s => s.work_date === date) || [];
  allDepartments.forEach(dep => {
    const workers = daySchedule.filter(s => s.department === dep).map(s => s.user_name).join(', ');
    text += `  └ *${dep}*: ${workers || 'Никто не работает ❌'}\n`;
  });
  return text;
};

// 4. ГРАФИК НА СЕГОДНЯ
bot.hears('📆 График на сегодня', async (ctx) => {
  const today = getTodayISO();
  const { data: scheduleData, error } = await supabase.from('schedule').select('*').eq('work_date', today);

  if (error) {
    console.error('Ошибка получения графика на сегодня:', error);
    return ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
  }

  let text = `📆 *График работы сотрудников на СЕГОДНЯ:*\n\n`;
  text += buildScheduleText(today, scheduleData);
  ctx.replyWithMarkdown(text);
});

// 5. ПРОСМОТР И УПРАВЛЕНИЕ ГРАФИКОМ НА НЕДЕЛЮ (по датам текущей недели)
bot.hears('📝 График работы на неделю', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();

  const weekDates = getCurrentWeekDates();
  const { data: scheduleData, error } = await supabase.from('schedule').select('*').in('work_date', weekDates);

  if (error) {
    console.error('Ошибка получения графика на неделю:', error);
    return ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
  }

  let text = '📝 *Текущий график работы сотрудников на неделю:*\n\n';
  weekDates.forEach(date => {
    text += buildScheduleText(date, scheduleData);
    text += '\n';
  });

  if (me && isStaff(me.role)) {
    const buttons = weekDates.map(date => [Markup.button.callback(`⚙️ Редактировать график: ${getDayShortByDate(date)} ${formatDateShort(date)}`, `sched_day_${dateToCode(date)}`)]);
    ctx.replyWithMarkdown(text, Markup.inlineKeyboard(buttons));
  } else {
    ctx.replyWithMarkdown(text);
  }
});


// ==========================================
// АДМИНКА ГРАФИКА РАБОТЫ
// ==========================================

bot.action(/^sched_day_(\d{4})$/, async (ctx) => {
  const weekDates = getCurrentWeekDates();
  const dateCode = ctx.match[1];
  const date = codeToDate(dateCode, weekDates[0]);
  const buttons = allDepartments.map(dep => [Markup.button.callback(`Отдел: ${dep}`, `sched_dep_${dateCode}_${depCodes[dep]}`)]);
  ctx.editMessageText(`Редактирование графика на *${getDayFullByDate(date)}, ${formatDateShort(date)}*.\nВыберите отдел:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Отрендерить меню выбора сотрудников со статусами (кто уже добавлен, а кто нет)
const renderWorkersMenu = async (ctx, dateCode, depCode) => {
  const weekDates = getCurrentWeekDates();
  const date = codeToDate(dateCode, weekDates[0]);
  const dep = depCodesReverse[depCode];

  const { data: allUsers, error: usersError } = await supabase.from('users').select('id, name');
  const { data: currentWorkers, error: workersError } = await supabase.from('schedule').select('user_id').eq('work_date', date).eq('department', dep);

  if (usersError || workersError) {
    console.error('Ошибка загрузки меню сотрудников:', usersError || workersError);
    return ctx.answerCbQuery('⚠️ Ошибка загрузки данных', { show_alert: true });
  }

  if (!allUsers || allUsers.length === 0) return ctx.answerCbQuery('Нет пользователей в базе');

  const workerIds = currentWorkers?.map(w => w.user_id.toString()) || [];

  const buttons = allUsers.map(u => {
    const isAdded = workerIds.includes(u.id.toString());
    const label = isAdded ? `✅ ${u.name} (В смене)` : `➕ ${u.name}`;
    return [Markup.button.callback(label, `sched_toggle_${dateCode}_${depCode}_${u.id}`)];
  });

  buttons.push([Markup.button.callback('⬅️ Назад к отделам', `sched_day_${dateCode}`)]);

  await ctx.editMessageText(
    `Управление сменами: отдел *${dep}*, день *${getDayFullByDate(date)}, ${formatDateShort(date)}*.\nНажмите на имя сотрудника, чтобы добавить или удалить его из графика:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
};

bot.action(/^sched_dep_(\d{4})_(.+)$/, async (ctx) => {
  await renderWorkersMenu(ctx, ctx.match[1], ctx.match[2]);
});

bot.action(/^sched_toggle_(\d{4})_(.+)_(.+)$/, async (ctx) => {
  const dateCode = ctx.match[1];
  const depCode = ctx.match[2];
  const targetUserId = ctx.match[3].toString();
  const weekDates = getCurrentWeekDates();
  const date = codeToDate(dateCode, weekDates[0]);
  const dep = depCodesReverse[depCode];

  const { data: exist } = await supabase.from('schedule').select('id').eq('work_date', date).eq('department', dep).eq('user_id', targetUserId).maybeSingle();

  if (exist) {
    const { error } = await supabase.from('schedule').delete().eq('id', exist.id);
    if (error) {
      console.error('Ошибка удаления из графика:', error);
      return ctx.answerCbQuery('⚠️ Не удалось удалить из графика. Проверьте настройки доступа к базе.', { show_alert: true });
    }
    ctx.answerCbQuery('Сотрудник удален из графика');
  } else {
    const { data: user } = await supabase.from('users').select('name').eq('id', targetUserId).maybeSingle();
    if (user) {
      const { error } = await supabase.from('schedule').insert({ user_id: targetUserId, user_name: user.name, work_date: date, day_of_week: getDayFullByDate(date), department: dep });
      if (error) {
        console.error('Ошибка добавления в график:', error);
        return ctx.answerCbQuery('⚠️ Не удалось добавить в график. Проверьте настройки доступа к базе.', { show_alert: true });
      }
      ctx.answerCbQuery('Сотрудник добавлен в график 🎉');
    } else {
      return ctx.answerCbQuery('⚠️ Пользователь не найден', { show_alert: true });
    }
  }

  // Перерисовываем меню со свежими статусами только после подтверждённой записи
  await renderWorkersMenu(ctx, dateCode, depCode);
});


// ==========================================
// НАЗНАЧЕНИЕ ДЕЖУРНЫХ (СВЯЗАННОЕ С ГРАФИКОМ, поддержка НЕСКОЛЬКИХ дежурных на отдел)
// ==========================================

bot.action(/^staff_day_(\d{4})$/, async (ctx) => {
  const weekDates = getCurrentWeekDates();
  const dateCode = ctx.match[1];
  const date = codeToDate(dateCode, weekDates[0]);
  const buttons = allDepartments.map(dep => [Markup.button.callback(`Отдел: ${dep}`, `staff_dep_${dateCode}_${depCodes[dep]}`)]);
  ctx.editMessageText(`Управление дежурными на *${getDayFullByDate(date)}, ${formatDateShort(date)}*.\nВыберите отдел:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

// Меню назначения дежурных: показывает сотрудников из графика на этот день/отдел с галочками (дежурный/не дежурный)
const renderDutyMenu = async (ctx, dateCode, depCode) => {
  const weekDates = getCurrentWeekDates();
  const date = codeToDate(dateCode, weekDates[0]);
  const dep = depCodesReverse[depCode];

  const { data: workersToday, error: workersError } = await supabase.from('schedule').select('user_id, user_name').eq('work_date', date).eq('department', dep);
  const { data: currentDuties, error: dutiesError } = await supabase.from('duty').select('user_id').eq('work_date', date).eq('department', dep);

  if (workersError || dutiesError) {
    console.error('Ошибка загрузки меню дежурных:', workersError || dutiesError);
    return ctx.answerCbQuery('⚠️ Ошибка загрузки данных', { show_alert: true });
  }

  if (!workersToday || workersToday.length === 0) {
    const buttons = [[Markup.button.callback('⬅️ Назад к отделам', `staff_day_${dateCode}`)]];
    return ctx.editMessageText(`❌ Нельзя назначить дежурного на *${getDayFullByDate(date)}, ${formatDateShort(date)}* в отдел *${dep}*.\n\nПо графику работы в этот день в данном отделе *никто не числится*. Сначала заполните график!`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  }

  const dutyUserIds = currentDuties?.map(d => d.user_id.toString()) || [];

  const buttons = workersToday.map(w => {
    const isDuty = dutyUserIds.includes(w.user_id.toString());
    const label = isDuty ? `✅ ${w.user_name} (Дежурный)` : `➕ ${w.user_name}`;
    return [Markup.button.callback(label, `duty_toggle_${dateCode}_${depCode}_${w.user_id}`)];
  });
  buttons.push([Markup.button.callback('⬅️ Назад', `staff_day_${dateCode}`)]);

  ctx.editMessageText(
    `Назначаем дежурных в отдел *${dep}* на *${getDayFullByDate(date)}, ${formatDateShort(date)}*.\nМожно выбрать несколько человек. Нажмите на имя, чтобы назначить/снять дежурство:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
};

bot.action(/^staff_dep_(\d{4})_(.+)$/, async (ctx) => {
  await renderDutyMenu(ctx, ctx.match[1], ctx.match[2]);
});

bot.action(/^duty_toggle_(\d{4})_(.+)_(.+)$/, async (ctx) => {
  const dateCode = ctx.match[1];
  const depCode = ctx.match[2];
  const targetUserId = ctx.match[3].toString();
  const weekDates = getCurrentWeekDates();
  const date = codeToDate(dateCode, weekDates[0]);
  const dep = depCodesReverse[depCode];

  const { data: exist } = await supabase.from('duty').select('id').eq('work_date', date).eq('department', dep).eq('user_id', targetUserId).maybeSingle();

  if (exist) {
    const { error } = await supabase.from('duty').delete().eq('id', exist.id);
    if (error) {
      console.error('Ошибка снятия дежурства:', error);
      return ctx.answerCbQuery('⚠️ Не удалось снять дежурство.', { show_alert: true });
    }
    ctx.answerCbQuery('Дежурство снято');
  } else {
    const { data: targetUser } = await supabase.from('users').select('name').eq('id', targetUserId).maybeSingle();
    if (!targetUser) return ctx.answerCbQuery('⚠️ Пользователь не найден', { show_alert: true });

    const { error } = await supabase.from('duty').insert({ work_date: date, day_of_week: getDayFullByDate(date), department: dep, duty_name: targetUser.name, user_id: targetUserId });
    if (error) {
      console.error('Ошибка назначения дежурного:', error);
      return ctx.answerCbQuery('⚠️ Не удалось назначить дежурного.', { show_alert: true });
    }
    ctx.answerCbQuery(`Назначен: ${targetUser.name}`);

    try {
      await bot.telegram.sendMessage(targetUserId, `🔔 Вас назначили дежурным на *${getDayFullByDate(date)}, ${formatDateShort(date)}* в отдел *${dep}*!`, { parse_mode: 'Markdown' });
    } catch (e) {}
  }

  await renderDutyMenu(ctx, dateCode, depCode);
});


// ==========================================
// ЗАДАЧИ СОТРУДНИКАМ
// ==========================================

// Сохраняем "что бот ждёт от этого пользователя следующим сообщением"
const setPendingAction = async (userId, action) => {
  await supabase.from('users').update({ pending_action: action }).eq('id', userId);
};
const clearPendingAction = async (userId) => {
  await supabase.from('users').update({ pending_action: null }).eq('id', userId);
};

bot.hears('📌 Поставить задачу', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  if (!me || !isStaff(me.role)) return;

  const { data: allUsers } = await supabase.from('users').select('id, name').neq('id', userId);
  if (!allUsers || allUsers.length === 0) return ctx.reply('Нет сотрудников в базе.');

  const buttons = allUsers.map(u => [Markup.button.callback(u.name, `task_to_${u.id}`)]);
  ctx.reply('Кому поставить задачу?', Markup.inlineKeyboard(buttons));
});

bot.action(/^task_to_(.+)$/, async (ctx) => {
  const fromId = ctx.from.id.toString();
  const toId = ctx.match[1];

  await setPendingAction(fromId, JSON.stringify({ type: 'awaiting_task_text', to: toId }));
  ctx.answerCbQuery();
  ctx.editMessageText('✏️ Напишите текст задачи в следующем сообщении.');
});

bot.hears('📋 Задачи команды', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  if (!me || !isStaff(me.role)) return;

  const { data: tasks, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false }).limit(20);
  if (error) {
    console.error('Ошибка получения задач:', error);
    return ctx.reply('⚠️ Не удалось загрузить задачи.');
  }
  if (!tasks || tasks.length === 0) return ctx.reply('Активных задач нет.');

  let text = '📋 *Последние задачи команды:*\n\n';
  tasks.forEach(t => {
    const statusIcon = t.status === 'done' ? '✅' : '⏳';
    text += `${statusIcon} *${t.to_user_name}*: ${t.text}\n`;
  });
  ctx.replyWithMarkdown(text);
});

bot.action(/^task_done_(.+)$/, async (ctx) => {
  const taskId = ctx.match[1];
  const { data: task, error: fetchError } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();

  if (fetchError || !task) {
    return ctx.answerCbQuery('⚠️ Задача не найдена', { show_alert: true });
  }

  const { error } = await supabase.from('tasks').update({ status: 'done' }).eq('id', taskId);
  if (error) {
    console.error('Ошибка отметки задачи:', error);
    return ctx.answerCbQuery('⚠️ Не удалось отметить задачу', { show_alert: true });
  }

  ctx.answerCbQuery('Отмечено как выполнено ✅');
  ctx.editMessageText(`✅ *Выполнено:* ${task.text}`, { parse_mode: 'Markdown' });

  try {
    await bot.telegram.sendMessage(task.from_user_id, `✅ ${task.to_user_name} выполнил(а) задачу: "${task.text}"`);
  } catch (e) {}
});


// ==========================================
// ГРАФИК ЧЕРЕЗ СВОБОДНЫЙ ТЕКСТ (Gemini)
// ==========================================

// Сопоставление написанного имени с реальным пользователем из базы (без учёта регистра, по подстроке)
const matchUserByName = (writtenName, allUsers) => {
  const normalized = writtenName.trim().toLowerCase();
  let best = allUsers.find(u => u.name.toLowerCase() === normalized);
  if (best) return best;
  best = allUsers.find(u => u.name.toLowerCase().includes(normalized) || normalized.includes(u.name.toLowerCase()));
  return best || null;
};

const callGemini = async (userText, weekDates) => {
  const weekInfo = weekDates.map(d => `${d} (${getDayFullByDate(d)})`).join(', ');
  const prompt = `Ты помощник, который превращает свободный текст о графике работы или дежурствах в JSON.
Доступные отделы: ${allDepartments.join(', ')}.
Даты текущей недели: ${weekInfo}.
Если в тексте упомянут день недели без даты — определи дату из списка выше.
Если дата/день не указаны явно — считай, что речь про сегодня: ${getTodayISO()}.

Верни СТРОГО JSON без markdown и пояснений, формат:
{"entries": [{"date": "YYYY-MM-DD", "department": "название отдела", "worker": "имя сотрудника", "is_duty": true|false}]}

is_duty = true если человек назначается ДЕЖУРНЫМ (слова "дежурный", "дежурит"), иначе false (обычный график работы).
Если в тексте несколько человек на один отдел/дату — верни несколько записей entries.
Если не можешь понять текст — верни {"entries": []}.

Текст пользователя: "${userText}"`;

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Ошибка Gemini API:', errText);
    return null;
  }

  const data = await response.json();
  let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  raw = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Не удалось распарсить ответ Gemini:', raw);
    return null;
  }
};

bot.hears('🤖 Написать график текстом', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('role').eq('id', userId).maybeSingle();
  if (!me || !isStaff(me.role)) return;

  await setPendingAction(userId, JSON.stringify({ type: 'awaiting_ai_schedule_text' }));
  ctx.reply('✏️ Напишите свободным текстом, кто и где работает или дежурит.\nНапример: "завтра Вася Ж на обуви, а Кристина дежурная на кассе"');
});

// Применяем подтверждённые записи к базе (schedule или duty в зависимости от is_duty)
const applyScheduleEntries = async (entries) => {
  let okCount = 0, failCount = 0;
  for (const e of entries) {
    const table = e.is_duty ? 'duty' : 'schedule';
    const payload = e.is_duty
      ? { work_date: e.date, day_of_week: getDayFullByDate(e.date), department: e.department, duty_name: e.userName, user_id: e.userId }
      : { user_id: e.userId, user_name: e.userName, work_date: e.date, day_of_week: getDayFullByDate(e.date), department: e.department };

    // Не дублируем запись, если уже есть точно такая же
    const { data: exist } = await supabase.from(table).select('id').eq('work_date', e.date).eq('department', e.department).eq('user_id', e.userId).maybeSingle();
    if (exist) { okCount++; continue; }

    const { error } = await supabase.from(table).insert(payload);
    if (error) { console.error(`Ошибка записи (${table}):`, error); failCount++; } else { okCount++; }
  }
  return { okCount, failCount };
};

bot.action(/^ai_confirm_(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  const { data: req, error } = await supabase.from('ai_requests').select('*').eq('id', requestId).maybeSingle();
  if (error || !req) return ctx.answerCbQuery('⚠️ Запрос не найден или устарел', { show_alert: true });

  const entries = JSON.parse(req.entries_json);
  const { okCount, failCount } = await applyScheduleEntries(entries);

  await supabase.from('ai_requests').delete().eq('id', requestId);

  ctx.answerCbQuery('Записано ✅');
  ctx.editMessageText(`✅ Записано в график: ${okCount} запис(ей).${failCount > 0 ? `\n⚠️ Ошибок: ${failCount}` : ''}`);
});

bot.action(/^ai_cancel_(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await supabase.from('ai_requests').delete().eq('id', requestId);
  ctx.answerCbQuery('Отменено');
  ctx.editMessageText('❌ Отменено, изменения не внесены.');
});


// ==========================================
// БРОНИРОВАНИЯ (ОБЕДЫ)
// ==========================================

bot.hears('🙋 Бронь Завтрака и обеда', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: user } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
  if (!user) return ctx.reply('Сначала зарегистрируйтесь!');

  const buttons = allDepartments.map(dep => [Markup.button.callback(dep, `select_dep_${depCodes[dep]}`)]);
  ctx.reply('Выберите ваш отдел:', Markup.inlineKeyboard(buttons));
});

bot.action(/^select_dep_(.+)$/, (ctx) => {
  const depCode = ctx.match[1];
  const dep = depCodesReverse[depCode];
  const buttons = [];
  for (let i = 0; i < timeSlots.length; i += 3) {
    const row = [Markup.button.callback(timeSlots[i].split(' ')[0], `book_${depCode}_${i}`)];
    if (timeSlots[i+1]) row.push(Markup.button.callback(timeSlots[i+1].split(' ')[0], `book_${depCode}_${i+1}`));
    if (timeSlots[i+2]) row.push(Markup.button.callback(timeSlots[i+2].split(' ')[0], `book_${depCode}_${i+2}`));
    buttons.push(row);
  }
  ctx.editMessageText(`Отдел *${dep}*. Выберите время:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^book_(.+)_(.+)$/, async (ctx) => {
  const depCode = ctx.match[1];
  const dep = depCodesReverse[depCode];
  const slotIndex = parseInt(ctx.match[2]);
  const slot = timeSlots[slotIndex];
  const userId = ctx.from.id.toString();

  const { data: userRow } = await supabase.from('users').select('name').eq('id', userId).maybeSingle();
  const userName = userRow?.name || formatTelegramName(ctx.from);

  const { data: checkDep, error: checkError } = await supabase.from('bookings').select('*').eq('department', dep).eq('time_slot', slot);

  if (checkError) {
    console.error('Ошибка проверки слота:', checkError);
    return ctx.answerCbQuery('⚠️ Ошибка проверки слота. Попробуйте позже.', { show_alert: true });
  }

  if (checkDep && checkDep.length > 0) {
    return ctx.answerCbQuery(`Слот уже занят сотрудником ${checkDep[0].user_name}!`, { show_alert: true });
  }

  const { error: deleteError } = await supabase.from('bookings').delete().eq('user_id', userId).eq('department', dep);
  if (deleteError) {
    console.error('Ошибка очистки старой брони:', deleteError);
    return ctx.answerCbQuery('⚠️ Ошибка записи. Попробуйте позже.', { show_alert: true });
  }

  const { error: insertError } = await supabase.from('bookings').insert({ user_id: userId, department: dep, time_slot: slot, user_name: userName });
  if (insertError) {
    console.error('Ошибка создания брони:', insertError);
    return ctx.answerCbQuery('⚠️ Не удалось записаться. Попробуйте позже.', { show_alert: true });
  }

  ctx.answerCbQuery(`Успешно записаны! 🎉`);
  ctx.editMessageText(`Вы записаны в отдел *${dep}* на *${slot}*.`, { parse_mode: 'Markdown' });
});

bot.hears('❌ Отменить мою бронь', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { error } = await supabase.from('bookings').delete().eq('user_id', userId);
  ctx.reply(error ? 'Активных броней не найдено.' : 'Все ваши бронирования успешно отменены.', getMainMenu());
});

// ==========================================
// ОБРАБОТКА СВОБОДНОГО ТЕКСТА (должен идти после всех bot.hears)
// ==========================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const { data: me } = await supabase.from('users').select('pending_action').eq('id', userId).maybeSingle();
  if (!me?.pending_action) return; // нет ожидаемого действия — игнорируем (не наш текст)

  let pending;
  try { pending = JSON.parse(me.pending_action); } catch (e) { return clearPendingAction(userId); }

  if (pending.type === 'awaiting_ai_schedule_text') {
    await clearPendingAction(userId);
    const weekDates = getCurrentWeekDates();

    const waitMsg = await ctx.reply('🤖 Думаю...');
    const result = await callGemini(ctx.message.text, weekDates);

    if (!result || !result.entries || result.entries.length === 0) {
      return ctx.reply('⚠️ Не удалось понять текст. Попробуйте переформулировать, например: "завтра Вася Ж на обуви".');
    }

    const { data: allUsers } = await supabase.from('users').select('id, name');
    const resolvedEntries = [];
    const problems = [];

    for (const e of result.entries) {
      const dep = allDepartments.find(d => d.toLowerCase() === (e.department || '').toLowerCase());
      const matchedUser = matchUserByName(e.worker || '', allUsers || []);

      if (!dep) { problems.push(`Не нашёл отдел "${e.department}"`); continue; }
      if (!matchedUser) { problems.push(`Не нашёл сотрудника "${e.worker}"`); continue; }
      if (!e.date) { problems.push(`Не указана дата для "${e.worker}"`); continue; }

      resolvedEntries.push({ date: e.date, department: dep, userId: matchedUser.id, userName: matchedUser.name, is_duty: !!e.is_duty });
    }

    if (resolvedEntries.length === 0) {
      return ctx.reply(`⚠️ Не удалось сопоставить данные:\n${problems.join('\n')}`);
    }

    let preview = '🤖 *Я понял так:*\n\n';
    resolvedEntries.forEach(e => {
      preview += `${e.is_duty ? '🔔 Дежурный' : '👷 Работает'}: *${e.userName}* — *${e.department}*, ${getDayFullByDate(e.date)} ${formatDateShort(e.date)}\n`;
    });
    if (problems.length > 0) preview += `\n⚠️ Не учтено: ${problems.join('; ')}\n`;
    preview += '\nЗаписать в график?';

    const { data: savedReq, error: saveError } = await supabase.from('ai_requests').insert({ entries_json: JSON.stringify(resolvedEntries) }).select().single();
    if (saveError) {
      console.error('Ошибка сохранения ai_request:', saveError);
      return ctx.reply('⚠️ Ошибка обработки. Попробуйте снова.');
    }

    return ctx.replyWithMarkdown(preview, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Записать', `ai_confirm_${savedReq.id}`), Markup.button.callback('❌ Отмена', `ai_cancel_${savedReq.id}`)]
    ]));
  }

  if (pending.type === 'awaiting_task_text') {
    const taskText = ctx.message.text.trim();
    const { data: toUser } = await supabase.from('users').select('name').eq('id', pending.to).maybeSingle();

    await clearPendingAction(userId);

    if (!toUser) return ctx.reply('⚠️ Сотрудник не найден, задача не создана.');

    const { data: newTask, error } = await supabase.from('tasks').insert({
      from_user_id: userId,
      to_user_id: pending.to,
      to_user_name: toUser.name,
      text: taskText,
      status: 'pending'
    }).select().single();

    if (error) {
      console.error('Ошибка создания задачи:', error);
      return ctx.reply('⚠️ Не удалось создать задачу.');
    }

    ctx.reply(`✅ Задача поставлена для ${toUser.name}.`);

    try {
      await bot.telegram.sendMessage(
        pending.to,
        `📌 *Новая задача от руководителя:*\n${taskText}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Готово', `task_done_${newTask.id}`)]]) }
      );
    } catch (e) {
      ctx.reply('⚠️ Задача сохранена, но не удалось отправить уведомление сотруднику.');
    }
  }
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
