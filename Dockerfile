FROM node:22-alpine
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY app.js ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3001
USER node
CMD ["node", "app.js"]
