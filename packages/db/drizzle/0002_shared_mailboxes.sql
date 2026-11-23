CREATE TYPE "public"."user_kind" AS ENUM('person', 'shared');--> statement-breakpoint
CREATE TABLE "mailbox_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"access" text DEFAULT 'full' NOT NULL,
	"send_as" boolean DEFAULT false NOT NULL,
	"send_on_behalf" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" "user_kind" DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_permissions" ADD CONSTRAINT "mailbox_permissions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_permissions_uq" ON "mailbox_permissions" USING btree ("owner_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "mailbox_permissions_principal_idx" ON "mailbox_permissions" USING btree ("principal_type","principal_id");