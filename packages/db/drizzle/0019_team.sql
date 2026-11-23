CREATE TABLE "channel_members" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"notify" text,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hidden_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"team_id" uuid,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"folder_id" uuid,
	"dm_key" text,
	"is_general" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"channel_id" uuid,
	"message_id" uuid,
	"title" text DEFAULT 'Meeting' NOT NULL,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "team_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" uuid,
	"kind" text DEFAULT 'message' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"last_reply_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce(left(body, 100000), ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "team_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"path" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"started_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#4f46e5' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_presence" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text,
	"until" timestamp with time zone,
	"message" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "features" SET DEFAULT '{"mail":true,"calendar":true,"contacts":true,"tasks":true,"drive":true,"team":true}'::jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "team_settings" jsonb DEFAULT '{"guestAccess":true,"recording":true,"createTeams":"everyone","maxParticipants":50}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_meetings" ADD CONSTRAINT "team_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_meetings" ADD CONSTRAINT "team_meetings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_meetings" ADD CONSTRAINT "team_meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_message_reactions" ADD CONSTRAINT "team_message_reactions_message_id_team_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."team_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_message_reactions" ADD CONSTRAINT "team_message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_messages" ADD CONSTRAINT "team_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_recordings" ADD CONSTRAINT "team_recordings_meeting_id_team_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."team_meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_recordings" ADD CONSTRAINT "team_recordings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_presence" ADD CONSTRAINT "user_presence_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_members_user_idx" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channels_team_idx" ON "channels" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_dm_uq" ON "channels" USING btree ("org_id","dm_key");--> statement-breakpoint
CREATE UNIQUE INDEX "team_meetings_code_uq" ON "team_meetings" USING btree ("code");--> statement-breakpoint
CREATE INDEX "team_messages_channel_idx" ON "team_messages" USING btree ("channel_id","parent_id","created_at");--> statement-breakpoint
CREATE INDEX "team_messages_parent_idx" ON "team_messages" USING btree ("parent_id","created_at");--> statement-breakpoint
CREATE INDEX "team_messages_search_idx" ON "team_messages" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_group_uq" ON "teams" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "teams_org_idx" ON "teams" USING btree ("org_id");