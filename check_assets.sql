-- Asset'leri kontrol etmek için SQL sorguları

-- 1. Tüm cached_assets kayıtlarını görüntüle (son 20)
SELECT 
    key,
    asset_type,
    status,
    created_at,
    LEFT(value, 50) as value_preview
FROM cached_assets
ORDER BY created_at DESC
LIMIT 20;

-- 2. cached_asset_meta ile birlikte görüntüle (movement_id dahil)
SELECT 
    a.key,
    a.asset_type,
    a.status,
    a.created_at,
    m.movement_id,
    m.prompt,
    m.mode,
    m.source
FROM cached_assets a
LEFT JOIN cached_asset_meta m ON m.key = a.key
WHERE a.asset_type = 'image'
ORDER BY a.created_at DESC
LIMIT 20;

-- 3. Belirli bir movement_id'ye göre asset'leri bul
-- Örnek: "push_up" için
SELECT 
    a.key,
    a.asset_type,
    a.status,
    a.created_at,
    m.movement_id,
    m.prompt
FROM cached_assets a
LEFT JOIN cached_asset_meta m ON m.key = a.key
WHERE m.movement_id = 'push_up'  -- Buraya aradığınız movement_id'yi yazın
   OR a.key ILIKE '%push_up%'
ORDER BY a.created_at DESC;

-- 4. Tüm movement_id'leri listele (unique)
SELECT DISTINCT 
    movement_id,
    COUNT(*) as asset_count
FROM cached_asset_meta
WHERE movement_id IS NOT NULL
GROUP BY movement_id
ORDER BY asset_count DESC;

-- 5. movement_id olmayan asset'leri bul
SELECT 
    a.key,
    a.asset_type,
    a.status,
    a.created_at
FROM cached_assets a
LEFT JOIN cached_asset_meta m ON m.key = a.key
WHERE m.movement_id IS NULL
  AND a.asset_type = 'image'
ORDER BY a.created_at DESC;

-- 6. "movement_" prefix'li movement_id'leri bul (eski format - düzeltilmesi gerekenler)
SELECT 
    movement_id,
    COUNT(*) as count
FROM cached_asset_meta
WHERE movement_id LIKE 'movement_%'
GROUP BY movement_id
ORDER BY count DESC;

