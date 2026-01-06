# Production image
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including tsx)
RUN npm ci

# Copy source code
COPY . .

# Expose port
EXPOSE 8080

# Health check using wget (safer for ESM/Alpine)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/api/health || exit 1

# Start application using local tsx binary
CMD ["./node_modules/.bin/tsx", "src/server.ts"]

