ALTER TABLE "organizations" ADD COLUMN "smtp_relay_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "smtp_relay_host" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "smtp_relay_port" integer DEFAULT 587 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "smtp_relay_security" text DEFAULT 'starttls' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "smtp_relay_username" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "smtp_relay_password_enc" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "smtp_relay_domains" jsonb DEFAULT '[]'::jsonb NOT NULL;