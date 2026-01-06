-- Case-insensitive unique constraints for email and username
-- Requires Postgres with CREATE INDEX IF NOT EXISTS support

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
    ON users ((lower(email)));

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uidx
    ON users ((lower(username)));


