import { pgTable, text, integer } from "drizzle-orm/pg-core";

export const balancesTable = pgTable("balances", {
  userId: text("user_id").primaryKey(),
  hrn: text("hrn").notNull().default("0"),
  rub: text("rub").notNull().default("0"),
  ton: text("ton").notNull().default("0"),
  stars: text("stars").notNull().default("0"),
  successfulDeals: integer("successful_deals").notNull().default(0),
});

export type Balance = typeof balancesTable.$inferSelect;
