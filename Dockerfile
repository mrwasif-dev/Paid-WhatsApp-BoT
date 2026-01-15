FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies for native modules
RUN apk add --no-cache python3 make g++ git

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Create session directory
RUN mkdir -p session

# Expose port
EXPOSE 3000

# Start the bot
CMD ["node", "index.js"]
