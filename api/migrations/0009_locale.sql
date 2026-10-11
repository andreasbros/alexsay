-- Where and how the user lives, told to every session: language, currency, date and time conventions, and the clock.
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en-GB';
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/London';
