CREATE TABLE "blob_replicas" (
	"namespace" text NOT NULL,
	"sha256" text NOT NULL,
	"node_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_replicas_namespace_sha256_node_id_pk" PRIMARY KEY("namespace","sha256","node_id")
);
--> statement-breakpoint
CREATE TABLE "shared_files" (
	"path" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "blob_replicas_node_idx" ON "blob_replicas" USING btree ("node_id","namespace");