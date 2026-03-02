CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
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
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charts" (
	"id" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"md5" text NOT NULL,
	"title" text NOT NULL,
	"artist" text DEFAULT '' NOT NULL,
	"subtitle" text DEFAULT '' NOT NULL,
	"subartist" text DEFAULT '' NOT NULL,
	"genre" text DEFAULT '' NOT NULL,
	"rank" integer DEFAULT 2 NOT NULL,
	"total" double precision DEFAULT 160 NOT NULL,
	"play_level" integer DEFAULT 0 NOT NULL,
	"difficulty" integer DEFAULT 0 NOT NULL,
	"keymode" integer NOT NULL,
	"normal_note_count" integer DEFAULT 0 NOT NULL,
	"scratch_count" integer DEFAULT 0 NOT NULL,
	"ln_count" integer DEFAULT 0 NOT NULL,
	"bss_count" integer DEFAULT 0 NOT NULL,
	"mine_count" integer DEFAULT 0 NOT NULL,
	"length" bigint NOT NULL,
	"initial_bpm" double precision DEFAULT 0 NOT NULL,
	"max_bpm" double precision DEFAULT 0 NOT NULL,
	"min_bpm" double precision DEFAULT 0 NOT NULL,
	"main_bpm" double precision DEFAULT 0 NOT NULL,
	"avg_bpm" double precision DEFAULT 0 NOT NULL,
	"peak_density" double precision DEFAULT 0 NOT NULL,
	"avg_density" double precision DEFAULT 0 NOT NULL,
	"end_density" double precision DEFAULT 0 NOT NULL,
	"histogram_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bpm_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "charts_sha256_unique" UNIQUE("sha256"),
	CONSTRAINT "charts_md5_unique" UNIQUE("md5")
);
--> statement-breakpoint
CREATE TABLE "score_extras" (
	"id" text PRIMARY KEY NOT NULL,
	"score_id" text NOT NULL,
	"replay_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gauge_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "score_extras_score_id_unique" UNIQUE("score_id")
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"chart_id" text NOT NULL,
	"points" double precision NOT NULL,
	"max_points" double precision NOT NULL,
	"max_combo" integer DEFAULT 0 NOT NULL,
	"max_hits" integer NOT NULL,
	"judgement_counts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mine_hits" integer DEFAULT 0 NOT NULL,
	"normal_note_count" integer DEFAULT 0 NOT NULL,
	"scratch_count" integer DEFAULT 0 NOT NULL,
	"ln_count" integer DEFAULT 0 NOT NULL,
	"bss_count" integer DEFAULT 0 NOT NULL,
	"mine_count" integer DEFAULT 0 NOT NULL,
	"clear_type" text NOT NULL,
	"random_sequence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"random_seed" text DEFAULT '0' NOT NULL,
	"note_order_algorithm" integer DEFAULT 0 NOT NULL,
	"note_order_algorithm_p2" integer DEFAULT 0 NOT NULL,
	"dp_options" integer DEFAULT 0 NOT NULL,
	"game_version" text DEFAULT '0' NOT NULL,
	"length" bigint NOT NULL,
	"unix_timestamp" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "score_extras" ADD CONSTRAINT "score_extras_score_id_scores_id_fk" FOREIGN KEY ("score_id") REFERENCES "public"."scores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_chart_id_charts_id_fk" FOREIGN KEY ("chart_id") REFERENCES "public"."charts"("id") ON DELETE cascade ON UPDATE no action;