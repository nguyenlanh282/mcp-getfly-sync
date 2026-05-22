FROM node:22-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY public/ ./public/

# Create data directory for persistence
RUN mkdir -p /app/data

# Default port
ENV PORT=3456

EXPOSE 3456

CMD ["node", "src/index.js"]
