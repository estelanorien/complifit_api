-- 055_grocery_shopping.sql
-- Adds tables for grocery shopping bags and product cache

-- Shopping bags table
-- Stores user-generated shopping lists from meal plans
CREATE TABLE IF NOT EXISTS shopping_bags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    meal_plan_id UUID REFERENCES meal_plans(id) ON DELETE SET NULL,
    days_covered INTEGER NOT NULL DEFAULT 7,
    estimated_total NUMERIC(10, 2),
    currency TEXT DEFAULT 'TRY',
    store TEXT, -- 'migros', 'bim', 'a101', 'getir', 'yemeksepeti_market', 'mixed'
    status TEXT DEFAULT 'draft', -- 'draft', 'ready', 'ordered', 'completed'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_shopping_bags_user_id ON shopping_bags(user_id, created_at DESC);

-- Index for meal plan linkage
CREATE INDEX IF NOT EXISTS idx_shopping_bags_meal_plan ON shopping_bags(meal_plan_id) WHERE meal_plan_id IS NOT NULL;

-- Product cache table (Open Food Facts)
-- Caches product data from external APIs to minimize requests
CREATE TABLE IF NOT EXISTS product_cache (
    barcode TEXT PRIMARY KEY,
    product_data JSONB NOT NULL,
    source TEXT DEFAULT 'openfoodfacts',
    cached_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
    access_count INTEGER DEFAULT 1
);

-- Index for cache expiration cleanup
CREATE INDEX IF NOT EXISTS idx_product_cache_expires ON product_cache(expires_at);

-- Trigger to update updated_at on shopping_bags
CREATE OR REPLACE FUNCTION update_shopping_bags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shopping_bags_updated_at_trigger ON shopping_bags;
CREATE TRIGGER shopping_bags_updated_at_trigger
    BEFORE UPDATE ON shopping_bags
    FOR EACH ROW
    EXECUTE FUNCTION update_shopping_bags_updated_at();

-- Add comment for documentation
COMMENT ON TABLE shopping_bags IS 'User shopping lists generated from meal plans';
COMMENT ON TABLE product_cache IS 'Cached product data from Open Food Facts API';
COMMENT ON COLUMN shopping_bags.items IS 'JSON array of GroceryItem objects';
COMMENT ON COLUMN shopping_bags.store IS 'Preferred store: migros, bim, a101, getir, yemeksepeti_market, or mixed';
COMMENT ON COLUMN product_cache.barcode IS 'Product barcode (EAN-13, UPC-A, etc.)';
