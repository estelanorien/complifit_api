-- Add inventory column to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS inventory JSONB DEFAULT '[]'::jsonb;
