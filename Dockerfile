# Use official Node.js LTS image (Alpine for small size)
FROM node:20-alpine

# Install build tools needed for better-sqlite3 native compilation
RUN apk add --no-cache python3 make g++

# Set working directory inside container
WORKDIR /app

# Copy package files first (Docker caches this layer if deps don't change)
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --production

# Copy the rest of the project
COPY . .

# Create data and logs directories
RUN mkdir -p data logs

# Make the CLI executable
RUN chmod +x bin/queuectl.js

# Default entry point — any arguments passed to `docker run` go to queuectl
ENTRYPOINT ["node", "bin/queuectl.js"]

# Default command (shows help if no arguments given)
CMD ["--help"]
