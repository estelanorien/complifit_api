-- Migration: Eat Out Feature Updates
-- Created: 2026-01-06
-- Description: Adds tables for Crowdsourced Restaurants, Menus, and Scans.

-- 1. Restaurants Table (Aggregates Google Places + Nutritionix + Manual)
CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_place_id text UNIQUE,
  name text NOT NULL,
  address text,
  lat numeric(10, 8),
  lng numeric(11, 8),
  cuisine text[],
  tier text DEFAULT 'public', -- 'public', 'verified_chain', 'verified_crowd'
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Menu Items Table (Linked to Restaurants)
CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price numeric(6, 2),
  calories int,
  protein int,
  carbs int,
  fat int,
  is_verified boolean DEFAULT false,
  verification_source text, -- 'user_scan', 'nutritionix_api', 'official_web'
  created_at timestamptz DEFAULT now()
);

-- 3. Menu Scans Table (Gamification Loop)
CREATE TABLE IF NOT EXISTS menu_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  image_url text, -- To be stored in Supabase Storage
  items_found_json jsonb, -- The raw AI output
  status text DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
  xp_awarded int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Indexes for Geo-spatial searching (simple approximate using lat/lng)
-- First ensure columns exist (table may have been created with different schema)
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS lat numeric(10, 8);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS lng numeric(11, 8);
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS restaurant_id uuid;
ALTER TABLE menu_scans ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE menu_scans ADD COLUMN IF NOT EXISTS restaurant_id uuid;

CREATE INDEX IF NOT EXISTS idx_restaurants_location ON restaurants(lat, lng);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_scans_user ON menu_scans(user_id);

-- Optional: RLS (Row Level Security) - Enable in production
-- ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE menu_scans ENABLE ROW LEVEL SECURITY;
