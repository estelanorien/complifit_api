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

# Clean dev dependencies for a smaller image
RUN npm prune --production

# Set Node.js memory options
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Start application
CMD ["node", "dist/server.cjs"]