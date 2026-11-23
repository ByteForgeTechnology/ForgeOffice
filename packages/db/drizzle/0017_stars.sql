CREATE TABLE "site_list_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "site_list_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"list_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_title" text DEFAULT '' NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stars" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stars_user_id_kind_target_id_pk" PRIMARY KEY("user_id","kind","target_id")
);
--> statement-breakpoint
ALTER TABLE "site_list_activity" ADD CONSTRAINT "site_list_activity_list_id_site_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."site_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_list_activity" ADD CONSTRAINT "site_list_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stars" ADD CONSTRAINT "stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_list_activity_item_idx" ON "site_list_activity" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "site_list_activity_time_idx" ON "site_list_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "stars_target_idx" ON "stars" USING btree ("kind","target_id");