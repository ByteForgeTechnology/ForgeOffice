CREATE TABLE "oauth_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"homepage_url" text,
	"type" text NOT NULL,
	"auth_method" text DEFAULT 'client_secret_basic' NOT NULL,
	"secret_enc" text,
	"secret_hint" text,
	"secret_created_at" timestamp with time zone,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"post_logout_redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '["openid","profile","email"]'::jsonb NOT NULL,
	"access" text DEFAULT 'all' NOT NULL,
	"group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consent" text DEFAULT 'user' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_apps" ADD CONSTRAINT "oauth_apps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_apps_client_id_uq" ON "oauth_apps" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_apps_org_idx" ON "oauth_apps" USING btree ("org_id");