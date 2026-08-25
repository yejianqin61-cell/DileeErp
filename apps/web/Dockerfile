FROM node:22-alpine AS build
WORKDIR /app
ARG API_INTERNAL_URL=http://localhost:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
COPY tsconfig.base.json ./tsconfig.base.json
RUN npm run build --workspace=@dilee/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
