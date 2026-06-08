import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const dealsTable = pgTable("deals", {
  dealId: text("deal_id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  buyerId: text("buyer_id"),
  title: text("title").notNull(),
  price: text("price").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Deal = typeof dealsTable.$inferSelect;
