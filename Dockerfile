FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.app.json tsconfig.tv.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src ./src
COPY app ./app
COPY tv ./tv
COPY scripts/build-app.mjs scripts/build-tv.mjs ./scripts/
RUN pnpm build && rm -rf dist/app-js

FROM node:24-alpine
ENV NODE_ENV=production
# The member listener (household addresses) on PORT and the admin listener (admin site and API, metrics, the Seerr
# webhook, health) on ADMIN_PORT. Inside the container both bind every interface; publish the admin port only to the
# host or a private network (see compose.yaml).
ENV HOST=0.0.0.0 PORT=8787 ADMIN_HOST=0.0.0.0 ADMIN_PORT=8788
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787 8788
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const h=process.env.ADMIN_HOST;const a=!h||h==='0.0.0.0'||h==='::'?'127.0.0.1':h.includes(':')?'['+h+']':h;fetch('http://'+a+':'+(process.env.ADMIN_PORT||8788)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
