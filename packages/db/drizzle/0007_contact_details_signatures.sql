CREATE TABLE "email_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"html" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"use_for_new" boolean DEFAULT true NOT NULL,
	"use_for_replies" boolean DEFAULT true NOT NULL,
	"apply_to_apps" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"blob_sha" text NOT NULL,
	"mime" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "office_location" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "work_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mobile_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "street_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pronouns" text;--> statement-breakpoint
ALTER TABLE "email_signatures" ADD CONSTRAINT "email_signatures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature_images" ADD CONSTRAINT "signature_images_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_signatures_org_idx" ON "email_signatures" USING btree ("org_id","priority");