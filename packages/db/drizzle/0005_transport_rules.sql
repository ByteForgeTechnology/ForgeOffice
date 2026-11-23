CREATE TABLE "transport_rule_hits" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transport_rule_hits_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rule_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sender" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"message_id" text,
	"mode" text NOT NULL,
	"actions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transport_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"mode" text DEFAULT 'enforce' NOT NULL,
	"applies_to" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"stop_processing" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transport_rule_hits" ADD CONSTRAINT "transport_rule_hits_rule_id_transport_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."transport_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_rules" ADD CONSTRAINT "transport_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transport_rule_hits_rule_idx" ON "transport_rule_hits" USING btree ("rule_id","created_at");--> statement-breakpoint
CREATE INDEX "transport_rule_hits_created_idx" ON "transport_rule_hits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "transport_rules_org_idx" ON "transport_rules" USING btree ("org_id","priority");