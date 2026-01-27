# Production image
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Expose port
EXPOSE 8080

# Set Node.js memory options
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Run built JS (no tsx at runtime = more reliable on Cloud Run)
CMD ["npm", "run", "start"]