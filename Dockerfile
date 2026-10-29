FROM node:22-bookworm

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3100
CMD ["npm", "run", "start:prod"]
