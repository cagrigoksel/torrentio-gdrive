FROM node:20-slim

WORKDIR /app

# Install system dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy addon package definition
COPY addon/package*.json ./

# Install dependencies
RUN npm install --production

# Copy addon source
COPY addon/ ./

# Hugging Face Spaces default port
ENV PORT=7860
ENV NODE_ENV=production
EXPOSE 7860

CMD ["node", "index.js"]
