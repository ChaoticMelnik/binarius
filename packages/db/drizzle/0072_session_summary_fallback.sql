CREATE INDEX "trading_sessions_summary_fallback_idx" ON "trading_sessions" USING btree ("final_notice_sent_at") WHERE "trading_sessions"."final_notice_sent_at" is not null and "trading_sessions"."summary_sent_at" is null;--> statement-breakpoint
-- Hand-written (#537, docs/bot-session.md -> The state): drizzle-kit does not model data. Before
-- #537 the backend sent the text summary as it set final_notice_sent_at; summary_sent_at was the
-- card's. From #537 summary_sent_at closes the summary step, and the backend's fallback sends its
-- text for a row with the first mark and without the second. Every such row already got its text
-- summary, so it is closed here and none is sent twice; its old card does not come any more.
UPDATE "trading_sessions" SET "summary_sent_at" = "final_notice_sent_at" WHERE "final_notice_sent_at" IS NOT NULL AND "summary_sent_at" IS NULL;
