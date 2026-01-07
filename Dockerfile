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

# Set Node.js memory options
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Start application using local tsx binary
CMD ["./node_modules/.bin/tsx", "src/server.ts"]