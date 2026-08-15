FROM node:24-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "--env-file-if-exists=.env", "server.js"]
