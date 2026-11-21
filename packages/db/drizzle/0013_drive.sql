CREATE TABLE "drive_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "drive_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"library_id" uuid NOT NULL,
	"item_id" uuid,
	"item_name" text DEFAULT '' NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drive_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version_id" uuid,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime" text,
	"sha256" text,
	"inherit_permissions" boolean DEFAULT true NOT NULL,
	"scan_status" text,
	"scan_detail" text,
	"thumbnail_sha" text,
	"text_content" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, coalesce(name, '')), 'A') || to_tsvector('simple'::regconfig, coalesce(left(text_content, 200000), ''))) STORED,
	"checked_out_by" uuid,
	"checked_out_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"trash_root_id" uuid
);
--> statement-breakpoint
CREATE TABLE "drive_libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" uuid,
	"group_id" uuid,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"item_id" uuid,
	"principal_type" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"max_downloads" integer,
	"download_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drive_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_id" uuid NOT NULL,
	"parent_id" uuid,
	"item_id" uuid,
	"name" text NOT NULL,
	"mime" text,
	"size" bigint NOT NULL,
	"received" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"blob_sha" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text,
	"comment" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"content" jsonb NOT NULL,
	"is_news" boolean DEFAULT false NOT NULL,
	"is_home" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4f46e5' NOT NULL,
	"library_id" uuid NOT NULL,
	"group_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "features" SET DEFAULT '{"mail":true,"calendar":true,"contacts":true,"tasks":true,"drive":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "drive_activity" ADD CONSTRAINT "drive_activity_library_id_drive_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."drive_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_activity" ADD CONSTRAINT "drive_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_comments" ADD CONSTRAINT "drive_comments_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_comments" ADD CONSTRAINT "drive_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_library_id_drive_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."drive_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_parent_id_drive_items_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_checked_out_by_users_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_libraries" ADD CONSTRAINT "drive_libraries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_libraries" ADD CONSTRAINT "drive_libraries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_libraries" ADD CONSTRAINT "drive_libraries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_permissions" ADD CONSTRAINT "drive_permissions_library_id_drive_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."drive_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_permissions" ADD CONSTRAINT "drive_permissions_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_permissions" ADD CONSTRAINT "drive_permissions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_share_links" ADD CONSTRAINT "drive_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_library_id_drive_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."drive_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_versions" ADD CONSTRAINT "drive_versions_item_id_drive_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."drive_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_versions" ADD CONSTRAINT "drive_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_pages" ADD CONSTRAINT "site_pages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_library_id_drive_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."drive_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_activity_library_idx" ON "drive_activity" USING btree ("library_id","created_at");--> statement-breakpoint
CREATE INDEX "drive_comments_item_idx" ON "drive_comments" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_items_name_uq" ON "drive_items" USING btree ("library_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name")) WHERE "drive_items"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "drive_items_parent_idx" ON "drive_items" USING btree ("library_id","parent_id");--> statement-breakpoint
CREATE INDEX "drive_items_trash_idx" ON "drive_items" USING btree ("library_id","deleted_at");--> statement-breakpoint
CREATE INDEX "drive_items_search_idx" ON "drive_items" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_libraries_personal_uq" ON "drive_libraries" USING btree ("owner_user_id") WHERE "drive_libraries"."kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "drive_libraries_group_uq" ON "drive_libraries" USING btree ("group_id") WHERE "drive_libraries"."kind" = 'group';--> statement-breakpoint
CREATE INDEX "drive_libraries_org_idx" ON "drive_libraries" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_permissions_uq" ON "drive_permissions" USING btree ("library_id",coalesce("item_id", '00000000-0000-0000-0000-000000000000'::uuid),"principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "drive_permissions_principal_idx" ON "drive_permissions" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "drive_share_links_item_idx" ON "drive_share_links" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_versions_item_number_uq" ON "drive_versions" USING btree ("item_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "site_pages_slug_uq" ON "site_pages" USING btree ("site_id","slug");--> statement-breakpoint
CREATE INDEX "site_pages_news_idx" ON "site_pages" USING btree ("site_id","is_news","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_slug_uq" ON "sites" USING btree ("org_id","slug");