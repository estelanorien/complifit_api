-- Migration: Add user_locations table for Spotter feature
-- Created: 2026-01-08
CREATE TABLE IF NOT EXISTS user_locations (
    user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    updated_at TIMESTAMP
    WITH
        TIME ZONE DEFAULT NOW ()
);

-- Index for geospatial queries (simple lat/lng bounding box)
CREATE INDEX IF NOT EXISTS idx_user_locations_coords ON user_locations (lat, lng);