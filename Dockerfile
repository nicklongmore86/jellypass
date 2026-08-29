FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
