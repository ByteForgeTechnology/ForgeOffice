CREATE TABLE "sender_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"list" text NOT NULL,
	"entry" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sender_lists" ADD CONSTRAINT "sender_lists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_lists" ADD CONSTRAINT "sender_lists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_lists" ADD CONSTRAINT "sender_lists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sender_lists_user_uq" ON "sender_lists" USING btree ("user_id","entry") WHERE "sender_lists"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sender_lists_org_uq" ON "sender_lists" USING btree ("org_id","entry") WHERE "sender_lists"."user_id" is null;