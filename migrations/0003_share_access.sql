ALTER TABLE shares ADD COLUMN short_code TEXT;
CREATE UNIQUE INDEX shares_short_code ON shares(short_code) WHERE short_code IS NOT NULL;
