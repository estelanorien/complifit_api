# Yeni Migration'lar - Profil Fotoğrafı ve Şifre Değiştirme

Bu dosya, profil fotoğrafı ve şifre değiştirme özellikleri için eklenen yeni migration'ları açıklar.

## Migration'lar

### 022_add_updated_at_to_users.sql
**Amaç:** `users` tablosuna `updated_at` kolonu ekler ve otomatik güncelleme trigger'ı oluşturur.

**Özellikler:**
- `updated_at` kolonu eklenir (timestamptz)
- Otomatik güncelleme için trigger oluşturulur
- Mevcut kayıtlar için backfill yapılır
- Index eklenir

**Çalıştırma:**
```bash
psql $DATABASE_URL -f migrations/022_add_updated_at_to_users.sql
```

### 023_add_avatar_to_user_profiles.sql
**Amaç:** `user_profiles` tablosuna `avatar_url` kolonu ekler.

**Özellikler:**
- `avatar_url` kolonu eklenir (TEXT - URL veya base64 destekler)
- Mevcut `profile_data` JSONB'deki avatar verilerini migrate eder
- Index eklenir (NULL olmayan kayıtlar için)
- Opsiyonel size constraint (yorumda)

**Çalıştırma:**
```bash
psql $DATABASE_URL -f migrations/023_add_avatar_to_user_profiles.sql
```

## Tüm Migration'ları Çalıştırma

```bash
cd vitality_api

# Sırayla çalıştır
psql $DATABASE_URL -f migrations/022_add_updated_at_to_users.sql
psql $DATABASE_URL -f migrations/023_add_avatar_to_user_profiles.sql

# Veya tek komutla
for file in migrations/022_*.sql migrations/023_*.sql; do
  echo "Running $file..."
  psql $DATABASE_URL -f "$file"
done
```

## Doğrulama

Migration'ların başarıyla çalıştığını doğrulamak için:

```sql
-- users tablosunu kontrol et
\d users

-- user_profiles tablosunu kontrol et
\d user_profiles

-- Trigger'ı kontrol et
SELECT tgname, tgtype, tgenabled 
FROM pg_trigger 
WHERE tgrelid = 'users'::regclass;

-- Index'leri kontrol et
\di idx_users_updated_at
\di idx_user_profiles_avatar_url
```

## Geri Alma (Rollback)

Eğer migration'ları geri almak isterseniz:

```sql
-- 023'ü geri al
ALTER TABLE user_profiles DROP COLUMN IF EXISTS avatar_url;
DROP INDEX IF EXISTS idx_user_profiles_avatar_url;

-- 022'yi geri al
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP FUNCTION IF EXISTS update_updated_at_column();
ALTER TABLE users DROP COLUMN IF EXISTS updated_at;
DROP INDEX IF EXISTS idx_users_updated_at;
```

## Backend Değişiklikleri

Bu migration'larla birlikte aşağıdaki backend dosyaları güncellendi:

1. **authService.ts** - `changePassword` metodu eklendi
2. **auth.ts routes** - `/auth/change-password` endpoint'i eklendi
3. **profiles.ts routes** - `avatar_url` kolonu desteği eklendi

## Frontend Değişiklikleri

1. **ProfileView.tsx** - Security tab'ı ve şifre değiştirme formu eklendi
2. **supabaseClient.ts** - `changePassword` API fonksiyonu eklendi

## Notlar

- Migration'lar idempotent'tir (birden fazla çalıştırılabilir)
- Mevcut veriler korunur ve migrate edilir
- Backward compatibility sağlanmıştır
- `avatar_url` NULL olabilir (opsiyonel)
- Şifre değişiklikleri `updated_at` ile track edilir

