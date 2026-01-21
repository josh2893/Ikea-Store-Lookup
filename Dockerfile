FROM node:20-alpine

WORKDIR /app

# Install deps (package*.json always matches package.json; also matches package-lock.json if present)
COPY package*.json ./
RUN npm install --omit=dev

# App files
COPY server.js ./server.js
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
