ALTER TABLE "organization" ADD COLUMN "org_usage_limit" numeric;--> statement-breakpoint
ALTER TABLE "user_stats" DROP COLUMN "usage_limit_set_by";--> statement-breakpoint
ALTER TABLE "user_stats" DROP COLUMN "billing_period_start";--> statement-breakpoint
ALTER TABLE "user_stats" DROP COLUMN "billing_period_end";