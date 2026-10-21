FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci --omit=dev

COPY --chown=node:node server ./server
USER node

EXPOSE 4000
CMD ["npm", "start"]
