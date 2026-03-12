# Complifit API (Vitality API)

> **English:** AI-powered backend API for the Complifit fitness and nutrition platform. Built with Fastify + TypeScript + PostgreSQL. Provides plan generation (training & nutrition), asset management, AI content generation (Gemini), background job processing, JWT authentication, and YouTube video upload. See `.env.example` for required configuration.

Vitality API, fitness ve beslenme planları oluşturmak için AI destekli bir backend servisidir. Fastify framework'ü üzerine kurulmuş, TypeScript ile yazılmıştır.

## Özellikler

- **AI Destekli Plan Oluşturma**: Google Gemini API kullanarak kişiselleştirilmiş antrenman ve beslenme planları
- **Kullanıcı Yönetimi**: JWT tabanlı kimlik doğrulama ve yetkilendirme
- **Veritabanı**: PostgreSQL ile veri yönetimi
- **Rate Limiting**: Endpoint bazlı rate limiting koruması
- **Structured Logging**: Pino tabanlı structured logging
- **Error Handling**: Merkezi hata yönetimi ve kullanıcı dostu hata mesajları
- **Background Jobs**: Asenkron iş işleme (image generation, content upgrade)

## Teknolojiler

- **Runtime**: Node.js 20+
- **Framework**: Fastify 4.x
- **Language**: TypeScript 5.x
- **Database**: PostgreSQL
- **AI**: Google Gemini API
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: Zod

## Kurulum

### Gereksinimler

- Node.js 20 veya üzeri
- PostgreSQL 12 veya üzeri
- npm veya yarn

### Adımlar

1. **Repository'yi klonlayın**
   ```bash
   git clone <repository-url>
   cd vitality_api
   ```

2. **Bağımlılıkları yükleyin**
   ```bash
   npm install
   ```

3. **Environment variables'ı ayarlayın**
   ```bash
   cp .env.example .env
   ```
   
   `.env` dosyasını düzenleyip gerekli değerleri girin (aşağıdaki bölüme bakın).

4. **Veritabanı migration'larını çalıştırın**
   ```bash
   npm run migrate
   ```
   veya
   ```bash
   ./run_all_migrations.sh
   ```

5. **Development modunda çalıştırın**
   ```bash
   npm run dev
   ```

6. **Production build**
   ```bash
   npm run build
   npm start
   ```

## Environment Variables

Tüm environment variable'lar `.env.example` dosyasında dokümante edilmiştir. Aşağıdaki değişkenler **zorunludur**:

### Zorunlu Değişkenler

- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: JWT için secret key (production'da minimum 32 karakter)
- `GEMINI_API_KEY`: Google Gemini API anahtarı

### Opsiyonel Değişkenler

- `PORT`: Server port (varsayılan: 8080)
- `NODE_ENV`: Environment (`development`, `production`, `test`)
- `ALLOWED_ORIGINS`: CORS için izin verilen origin'ler (virgülle ayrılmış)
- `GOOGLE_PLACES_KEY`: Google Places API anahtarı
- `DB_SSL_REJECT_UNAUTHORIZED`: Database SSL certificate validation (varsayılan: production'da `true`)

Detaylı liste için `.env.example` dosyasına bakın.

## API Endpoints

Tüm endpoint'ler `/api` prefix'i ile başlar.

### Authentication
- `POST /api/auth/signup` - Kullanıcı kaydı
- `POST /api/auth/login` - Giriş
- `POST /api/auth/refresh` - Token yenileme
- `POST /api/auth/change-password` - Şifre değiştirme
- `DELETE /api/auth/delete-account` - Hesap silme

### Plans
- `POST /api/plans/generate` - AI ile plan oluşturma (training + nutrition)
- `POST /api/plans/save` - Plan kaydetme
- `POST /api/plans/reroll/meal` - Yemek planını yeniden oluşturma
- `POST /api/plans/reroll/exercise` - Egzersiz planını yeniden oluşturma

### Training
- `POST /api/training/generate` - Antrenman planı oluşturma
- `POST /api/training/apply` - Antrenman planını uygulama
- `GET /api/training/archive` - Arşivlenmiş planları listeleme

### Nutrition
- `POST /api/nutrition/generate` - Beslenme planı oluşturma
- `POST /api/nutrition/apply` - Beslenme planını uygulama

### AI Services
- `POST /api/ai/text` - Metin üretimi
- `POST /api/ai/image` - Görsel üretimi
- `POST /api/ai/generate-content` - Genel içerik üretimi

### Jobs (Background Processing)
- `POST /api/jobs/submit` - İş gönderme
- `GET /api/jobs/:id` - İş durumu sorgulama

### Health
- `GET /api/health` - Health check endpoint

Detaylı API dokümantasyonu için route dosyalarına bakın: `src/infra/http/routes/`

## Proje Yapısı

```
vitality_api/
├── src/
│   ├── application/        # Business logic
│   │   └── services/      # Service classes
│   ├── config/            # Configuration
│   ├── infra/             # Infrastructure
│   │   ├── db/            # Database (pool, migrations)
│   │   ├── http/          # HTTP layer
│   │   │   ├── hooks/     # Request/response hooks
│   │   │   ├── middleware/# Middleware (errors, rate limit)
│   │   │   ├── routes/    # Route handlers
│   │   │   └── schemas/  # Zod validation schemas
│   │   └── logger.ts      # Standalone logger
│   ├── services/          # External service integrations
│   └── server.ts          # Application entry point
├── migrations/            # Database migrations
├── scripts/               # Utility scripts
├── .env.example           # Environment variables template
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Scripts

- `npm run dev` - Development mode (tsx watch)
- `npm run build` - Production build
- `npm start` - Production mode
- `npm run lint` - ESLint check

### Code Style

- TypeScript strict mode aktif
- ESLint ile kod kalitesi kontrolü
- Zod ile input validation

## Deployment

### Docker

```bash
docker build -t vitality-api .
docker run -p 8080:8080 --env-file .env vitality-api
```

### Cloud Run / Production

1. Environment variables'ı Cloud Run'da ayarlayın
2. `DB_SSL_REJECT_UNAUTHORIZED=false` ayarlayın (Cloud SQL proxy kullanıyorsanız)
3. `ALLOWED_ORIGINS` değişkenini production domain'lerinizle ayarlayın
4. Health check endpoint: `/api/health`

## Güvenlik

- JWT token tabanlı authentication
- Rate limiting (endpoint bazlı)
- Helmet.js ile security headers
- CORS yapılandırması
- Input validation (Zod)
- SQL injection koruması (parameterized queries)
- Production'da error message exposure kapalı

## Logging

- Structured JSON logging (Pino format)
- Request ID tracking
- Production'da stack trace gizli
- Log levels: `debug`, `info`, `warn`, `error`

## Veritabanı

- PostgreSQL connection pooling
- Migration sistemi
- Transaction yönetimi
- Connection leak koruması

## Troubleshooting

### Database Connection Issues

- `DATABASE_URL` formatını kontrol edin: `postgresql://user:password@host:port/database`
- SSL ayarlarını kontrol edin (`DB_SSL_REJECT_UNAUTHORIZED`)
- Connection pool limitlerini kontrol edin (`src/infra/db/pool.ts`)

### AI Generation Failures

- `GEMINI_API_KEY` doğru mu kontrol edin
- Rate limit'leri kontrol edin
- API quota'nızı kontrol edin

### Memory Issues

- Connection pool size'ı azaltın
- Background job frequency'sini azaltın
- Memory monitoring'i aktif edin

## Lisans

[Lisans bilgisi buraya]

## Destek

[Destek bilgileri buraya]
