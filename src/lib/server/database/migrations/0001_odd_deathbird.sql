ALTER TABLE "charts" ALTER COLUMN "rank" SET DATA TYPE double precision USING (CASE WHEN "rank" = 0 THEN 25 WHEN "rank" = 1 THEN 50 WHEN "rank" = 2 THEN 75 WHEN "rank" = 3 THEN 100 ELSE "rank" END);
ALTER TABLE "charts" ALTER COLUMN "rank" SET DEFAULT 75;
