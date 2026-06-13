FROM node:24-slim AS builder

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build
RUN pnpm --filter @workspace/api-server deploy --prod --legacy /prod/api-server
RUN cp -R artifacts/api-server/dist /prod/api-server/dist

FROM node:24-slim AS runtime

WORKDIR /app

ENV NODE_ENV="production"
ENV PORT="8080"

COPY --from=builder /prod/api-server ./

EXPOSE 8080

CMD ["node", "dist/index.cjs"]
