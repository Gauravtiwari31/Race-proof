FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY apps apps
RUN pnpm build
RUN pnpm --filter api --prod deploy --legacy /deploy

FROM node:22-slim
ENV NODE_ENV=production
# dist/db/migrate.js finds the migrations at ../../../../db, so keep the repo's relative layout.
WORKDIR /app/apps/api
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/public ./public
COPY --from=build /app/apps/api/package.json ./package.json
COPY db /app/db
COPY ops/release-and-start.sh /app/release-and-start.sh
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
