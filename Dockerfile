# Production image
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript to JavaScript (Optional if using start:direct, but keeps check for errors)
RUN npm run build

# Expose port
EXPOSE 8080

# Clean dev dependencies for a smaller image
# RUN npm prune --production

# Set Node.js memory options
ENV NODE_OPTIONS="--max-old-space-size=1536"

# Start application (Direct Execution to avoid Bundle issues)
CMD ["npm", "run", "start:direct"]