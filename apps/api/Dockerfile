FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci
COPY apps/api apps/api
COPY tsconfig.base.json ./tsconfig.base.json
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npm run build --workspace=@dilee/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/api/prisma/seed.ts ./apps/api/prisma/seed.ts
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && npx tsx apps/api/prisma/seed.ts && node apps/api/dist/main.js"]
