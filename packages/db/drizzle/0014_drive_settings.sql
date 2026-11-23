ALTER TABLE "organizations" ADD COLUMN "drive_settings" jsonb DEFAULT '{"trashDays":93,"maxUploadMb":10240,"externalSharing":true,"linkMaxDays":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "wopi_lock" text;--> statement-breakpoint
ALTER TABLE "drive_items" ADD COLUMN "wopi_lock_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_libraries" ADD COLUMN "everyone_role" text;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "visibility" text DEFAULT 'members' NOT NULL;