import app from "./app";
import { logger } from "./lib/logger";
import { createBot } from "./bot";
import { webhookCallback } from "grammy";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const bot = createBot();

if (bot) {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    const replitDomains = process.env.REPLIT_DOMAINS;
    const renderEnvUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
    const renderHardcoded = "https://king-garant-bot-id5t.onrender.com";

    let publicUrl: string;
    if (replitDomains) {
      publicUrl = `https://${replitDomains.split(",")[0].trim()}`;
    } else if (renderEnvUrl) {
      publicUrl = renderEnvUrl;
    } else {
      publicUrl = renderHardcoded;
    }

    const webhookPath = "/api/telegram/webhook";
    const webhookUrl = `${publicUrl}${webhookPath}`;

    app.post(webhookPath, webhookCallback(bot, "express"));

    bot.api.setWebhook(webhookUrl, { drop_pending_updates: true })
      .then(() => logger.info({ webhookUrl }, "Telegram webhook set"))
      .catch((err) => logger.error({ err }, "Failed to set webhook"));

    logger.info({ publicUrl }, "Telegram bot running in webhook mode");
  } else {
    // Dev mode: do NOT run the bot locally — only Render runs it.
    // This prevents polling from stealing updates away from the Render webhook.
    logger.info("Dev mode: bot is disabled locally — runs only on Render (production)");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
