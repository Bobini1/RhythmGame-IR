CREATE TABLE "account" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" bigint NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "session_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" bigint NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verification_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "charts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sha256" text NOT NULL,
	"md5" text NOT NULL,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"subartist" text DEFAULT '' NOT NULL,
	"genre" text DEFAULT '' NOT NULL,
	"rank" integer DEFAULT 2 NOT NULL,
	"total" double precision DEFAULT 160 NOT NULL,
	"play_level" integer NOT NULL,
	"difficulty" integer NOT NULL,
	"keymode" integer NOT NULL,
	"normal_note_count" integer NOT NULL,
	"scratch_count" integer NOT NULL,
	"ln_count" integer NOT NULL,
	"bss_count" integer NOT NULL,
	"mine_count" integer NOT NULL,
	"length" bigint NOT NULL,
	"initial_bpm" double precision NOT NULL,
	"max_bpm" double precision NOT NULL,
	"min_bpm" double precision NOT NULL,
	"main_bpm" double precision NOT NULL,
	"avg_bpm" double precision NOT NULL,
	"peak_density" double precision NOT NULL,
	"avg_density" double precision NOT NULL,
	"end_density" double precision NOT NULL,
	"game_version" bigint NOT NULL,
	"histogram_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bpm_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "charts_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "charts_md5_unique" UNIQUE("md5")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "integrations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"guid" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"md5" text NOT NULL,
	"points" double precision NOT NULL,
	"max_points" double precision NOT NULL,
	"max_combo" integer NOT NULL,
	"max_hits" integer NOT NULL,
	"judgement_counts" jsonb NOT NULL,
	"mine_hits" integer NOT NULL,
	"normal_note_count" integer NOT NULL,
	"scratch_count" integer NOT NULL,
	"ln_count" integer NOT NULL,
	"bss_count" integer NOT NULL,
	"mine_count" integer NOT NULL,
	"clear_type" text NOT NULL,
	"random_sequence" jsonb NOT NULL,
	"random_seed" bigint NOT NULL,
	"note_order_algorithm" integer NOT NULL,
	"note_order_algorithm_p2" integer NOT NULL,
	"dp_options" integer NOT NULL,
	"keymode" integer NOT NULL,
	"game_version" bigint NOT NULL,
	"length" bigint NOT NULL,
	"unix_timestamp" integer NOT NULL,
	"replay_data" jsonb NOT NULL,
	"gauge_history" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_md5_charts_md5_fk" FOREIGN KEY ("md5") REFERENCES "public"."charts"("md5") ON DELETE cascade ON UPDATE no action;