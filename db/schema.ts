import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const shelfcheckStates = sqliteTable("shelfcheck_states", {
  userId: text("user_id").primaryKey(),
  payload: text("payload").notNull().default("{}"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const shelfcheckStateChunks = sqliteTable("shelfcheck_state_chunks", {
  userId: text("user_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  payload: text("payload").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [primaryKey({ columns: [table.userId, table.chunkIndex] })]);
