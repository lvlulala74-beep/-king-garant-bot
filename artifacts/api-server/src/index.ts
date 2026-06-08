import app from "./app";
import { logger } from "./lib/logger";
import { createBot } from "./bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Start Telegram bot
const bot = createBot();
if (bot) {
  bot.start({
    onStart: (info) => logger.info({ username: info.username }, "Bot started"),
  }).catch((err) => {
    logger.error({ err }, "Bot crashed");
  });
  logger.info("Telegram bot starting...");
}
