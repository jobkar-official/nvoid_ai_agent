FROM node:22-bookworm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
EXPOSE 3100
CMD ["npm", "run", "start:prod"]
