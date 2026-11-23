CREATE TABLE "address_book_shares" (
	"address_book_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"access" text NOT NULL,
	CONSTRAINT "address_book_shares_address_book_id_principal_type_principal_id_pk" PRIMARY KEY("address_book_id","principal_type","principal_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_preferences" (
	"user_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"reminders" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_preferences_user_id_calendar_id_pk" PRIMARY KEY("user_id","calendar_id")
);
--> statement-breakpoint
CREATE TABLE "folder_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"access" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address_book_shares" ADD CONSTRAINT "address_book_shares_address_book_id_address_books_id_fk" FOREIGN KEY ("address_book_id") REFERENCES "public"."address_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_preferences" ADD CONSTRAINT "calendar_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_preferences" ADD CONSTRAINT "calendar_preferences_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_permissions" ADD CONSTRAINT "folder_permissions_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_permissions" ADD CONSTRAINT "folder_permissions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folder_permissions_uq" ON "folder_permissions" USING btree ("mailbox_id","principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "folder_permissions_principal_idx" ON "folder_permissions" USING btree ("principal_type","principal_id");