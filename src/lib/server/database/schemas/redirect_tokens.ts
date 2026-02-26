/* eslint-disable @typescript-eslint/no-unused-vars */
import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core';

export const redirect_token = pgTable('redirect_token', {
  token: text('token').primaryKey(),
  sessionId: text('session_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  used: boolean('used').default(false).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
