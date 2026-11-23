CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"login_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"clients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "session_max_hours" integer DEFAULT 336 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "session_idle_minutes" integer;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id","last_seen_at");