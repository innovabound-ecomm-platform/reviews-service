# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files
COPY pnpm-workspace.yaml ./
COPY package.json ./
COPY pnpm-lock.yaml ./

# Copy package files for dependencies
COPY reviews-service/package.json ./reviews-service/
COPY reviews-db/package.json ./reviews-db/
COPY kafka-client/package.json ./kafka-client/
COPY typescript-config/package.json ./typescript-config/
COPY eslint-config/package.json ./eslint-config/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source files
COPY reviews-service ./reviews-service
COPY reviews-db ./reviews-db
COPY kafka-client ./kafka-client
COPY typescript-config ./typescript-config
COPY eslint-config ./eslint-config

# Generate Prisma client
WORKDIR /app/reviews-db
RUN pnpm prisma generate

# Build the service
WORKDIR /app/reviews-service
RUN pnpm build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy built files and dependencies
COPY --from=builder /app/reviews-service/dist ./dist
COPY --from=builder /app/reviews-service/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/reviews-db ./reviews-db

# Set environment
ENV NODE_ENV=production
ENV PORT=3013

EXPOSE 3013

CMD ["node", "dist/index.js"]
