CREATE TYPE "public"."calendar_owner_type" AS ENUM('user', 'group', 'resource');--> statement-breakpoint
CREATE TYPE "public"."outbound_status" AS ENUM('scheduled', 'queued', 'sending', 'sent', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "address_books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sync_revision" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_passwords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_replies" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"subject" text DEFAULT 'Out of office' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"internal_only" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_reply_log" (
	"user_id" uuid NOT NULL,
	"sender" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_reply_log_user_id_sender_pk" PRIMARY KEY("user_id","sender")
);
--> statement-breakpoint
CREATE TABLE "calendar_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"href" text NOT NULL,
	"etag" text NOT NULL,
	"ics" text NOT NULL,
	"component_type" text DEFAULT 'VEVENT' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"recurring" boolean DEFAULT false NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"organizer" text,
	"transparent" boolean DEFAULT false NOT NULL,
	"sync_revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_shares" (
	"calendar_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"access" text NOT NULL,
	CONSTRAINT "calendar_shares_calendar_id_principal_type_principal_id_pk" PRIMARY KEY("calendar_id","principal_type","principal_id")
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_type" "calendar_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4f46e5' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sync_revision" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address_book_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"href" text NOT NULL,
	"etag" text NOT NULL,
	"vcard" text NOT NULL,
	"full_name" text DEFAULT '' NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"organization" text DEFAULT '' NOT NULL,
	"sync_revision" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"match" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"blob_sha" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"path" text NOT NULL,
	"special_use" text,
	"uid_validity" integer NOT NULL,
	"uid_next" integer DEFAULT 1 NOT NULL,
	"modseq" bigint DEFAULT 1 NOT NULL,
	"subscribed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"mailbox_id" uuid NOT NULL,
	"uid" integer NOT NULL,
	"modseq" bigint NOT NULL,
	"blob_sha" text NOT NULL,
	"size" integer NOT NULL,
	"internal_date" timestamp with time zone DEFAULT now() NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_id" text,
	"in_reply_to" text,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thread_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_addr" jsonb,
	"to_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc_addrs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"snippet" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mime_tree" jsonb NOT NULL,
	"search_addresses" text DEFAULT '' NOT NULL,
	"spam_score" real,
	"auth_results" jsonb,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce(subject, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(search_addresses, '')), 'B') || to_tsvector('simple'::regconfig, coalesce(left(body_text, 200000), ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"blob_sha" text NOT NULL,
	"size" integer NOT NULL,
	"envelope_from" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"status" "outbound_status" DEFAULT 'queued' NOT NULL,
	"send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_message_id" uuid,
	"source" text NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quarantine" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"blob_sha" text NOT NULL,
	"size" integer NOT NULL,
	"envelope_from" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"from_header" text DEFAULT '' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"reason" text NOT NULL,
	"spam_score" real,
	"auth_results" jsonb,
	"remote_ip" text,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"kind" text DEFAULT 'room' NOT NULL,
	"capacity" integer,
	"location" text DEFAULT '' NOT NULL,
	"auto_accept" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_aliases_address_unique" UNIQUE("address")
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "catch_all_user_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_selector" text DEFAULT 'forge' NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "dkim_public_key" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "mail_max_message_bytes" integer DEFAULT 36700160 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "undo_send_seconds" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "address_books" ADD CONSTRAINT "address_books_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_passwords" ADD CONSTRAINT "app_passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_replies" ADD CONSTRAINT "auto_replies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_reply_log" ADD CONSTRAINT "auto_reply_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_objects" ADD CONSTRAINT "calendar_objects_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_shares" ADD CONSTRAINT "calendar_shares_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_address_book_id_address_books_id_fk" FOREIGN KEY ("address_book_id") REFERENCES "public"."address_books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_filters" ADD CONSTRAINT "mail_filters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_uploads" ADD CONSTRAINT "mail_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantine" ADD CONSTRAINT "quarantine_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_aliases" ADD CONSTRAINT "user_aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "address_books_user_idx" ON "address_books" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_passwords_user_idx" ON "app_passwords" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_objects_href_uq" ON "calendar_objects" USING btree ("calendar_id","href");--> statement-breakpoint
CREATE INDEX "calendar_objects_uid_idx" ON "calendar_objects" USING btree ("calendar_id","uid");--> statement-breakpoint
CREATE INDEX "calendar_objects_range_idx" ON "calendar_objects" USING btree ("calendar_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "calendar_objects_sync_idx" ON "calendar_objects" USING btree ("calendar_id","sync_revision");--> statement-breakpoint
CREATE INDEX "calendars_owner_idx" ON "calendars" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_href_uq" ON "contacts" USING btree ("address_book_id","href");--> statement-breakpoint
CREATE INDEX "contacts_book_sync_idx" ON "contacts" USING btree ("address_book_id","sync_revision");--> statement-breakpoint
CREATE INDEX "mail_filters_user_idx" ON "mail_filters" USING btree ("user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_user_path_uq" ON "mailboxes" USING btree ("user_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_mailbox_uid_uq" ON "messages" USING btree ("mailbox_id","uid");--> statement-breakpoint
CREATE INDEX "messages_mailbox_date_idx" ON "messages" USING btree ("mailbox_id","internal_date");--> statement-breakpoint
CREATE INDEX "messages_user_thread_idx" ON "messages" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "messages_user_msgid_idx" ON "messages" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "messages_search_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "outbound_user_idx" ON "outbound_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "outbound_status_idx" ON "outbound_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quarantine_created_idx" ON "quarantine" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_catch_all_user_id_users_id_fk" FOREIGN KEY ("catch_all_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;