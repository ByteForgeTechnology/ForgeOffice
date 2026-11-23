ALTER TABLE "drive_libraries" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_libraries" ADD COLUMN "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "drive_libraries" ADD CONSTRAINT "drive_libraries_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;