# Sunucuda API Kurulum ve Çalıştırma Rehberi

## 1. Gereksinimler
- Node.js (v18 veya üzeri)
- PostgreSQL veritabanı
- npm veya yarn

## 2. Kurulum Adımları

### 2.1. Dosyaları Sunucuya Yükleyin
```bash
# Zip dosyasını sunucuya yükleyin ve açın
unzip vitality_api_production.zip
cd vitality_api
```

### 2.2. Environment Dosyası Oluşturun
`.env` dosyası oluşturun:
```bash
nano .env
```

Aşağıdaki içeriği ekleyin (kendi değerlerinizle değiştirin):
```env
PORT=8080
DATABASE_URL=postgresql://kullanici:sifre@localhost:5432/veritabani_adi
JWT_SECRET=your-super-secret-jwt-key-change-this
GEMINI_API_KEY=your-gemini-api-key-if-needed
```

**Önemli:** 
- `DATABASE_URL`: PostgreSQL bağlantı string'iniz
- `JWT_SECRET`: Güçlü bir rastgele string (token şifreleme için)
- `GEMINI_API_KEY`: AI özellikleri için gerekli (opsiyonel)

### 2.3. Veritabanı Migrations'ları Çalıştırın

**Yöntem 1: Otomatik Script (Önerilen)**
```bash
# Script'i çalıştırılabilir yapın
chmod +x run_all_migrations.sh

# Tüm migrations'ları çalıştırın (.env dosyasından DATABASE_URL'i otomatik alır)
./run_all_migrations.sh
```

**Yöntem 2: Manuel (Her migration'ı tek tek)**
```bash
# .env dosyasından DATABASE_URL'i alın
source .env

# Her migration'ı sırayla çalıştırın
psql "$DATABASE_URL" -f migrations/001_app_extensions.sql
psql "$DATABASE_URL" -f migrations/002_auth.sql
psql "$DATABASE_URL" -f migrations/003_logs.sql
# ... diğer migration dosyaları
```

**Yöntem 3: Tek komutla (bash script olarak)**
```bash
# .env'den DATABASE_URL'i al
export DATABASE_URL=$(grep DATABASE_URL .env | cut -d '=' -f2-)

# Tüm migrations'ları çalıştır
for file in migrations/*.sql; do psql "$DATABASE_URL" -f "$file"; done
```

## 3. API'yi Çalıştırma

### 3.1. Basit Çalıştırma (Test için)
```bash
npm start
```

### 3.2. Production için PM2 ile Çalıştırma (Önerilen)

#### PM2 Kurulumu
```bash
npm install -g pm2
```

#### PM2 ile Başlatma
```bash
pm2 start npm --name "vitality-api" -- start
```

#### PM2 Komutları
```bash
# Durumu kontrol et
pm2 status

# Logları görüntüle
pm2 logs vitality-api

# Yeniden başlat
pm2 restart vitality-api

# Durdur
pm2 stop vitality-api

# Otomatik başlatma (sunucu yeniden başladığında)
pm2 startup
pm2 save
```

### 3.3. Nginx Reverse Proxy (Opsiyonel)

Eğer Nginx kullanıyorsanız, `/etc/nginx/sites-available/vitality-api` dosyası oluşturun:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Sonra:
```bash
sudo ln -s /etc/nginx/sites-available/vitality-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 4. Güvenlik Kontrolleri

- [ ] `.env` dosyası güvenli bir yerde ve erişim kısıtlı
- [ ] Firewall'da sadece gerekli portlar açık
- [ ] `JWT_SECRET` güçlü ve benzersiz
- [ ] Database şifresi güçlü
- [ ] HTTPS kullanılıyor (production için)

## 5. Sorun Giderme

### Port zaten kullanımda
```bash
# Hangi process port 8080'i kullanıyor?
lsof -i :8080
# veya
netstat -tulpn | grep 8080
```

### Database bağlantı hatası
- `DATABASE_URL` formatını kontrol edin
- PostgreSQL servisinin çalıştığından emin olun: `sudo systemctl status postgresql`
- Firewall kurallarını kontrol edin

### Logları kontrol et
```bash
# PM2 logları
pm2 logs vitality-api

# Veya direkt çalıştırıyorsanız terminal çıktısını kontrol edin
```

## 6. Health Check

API çalışıyor mu kontrol edin:
```bash
curl http://localhost:8080/health
```

Başarılı yanıt:
```json
{"status":"ok"}
```

