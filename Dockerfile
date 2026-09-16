FROM node:24.20.0-bookworm-slim
# true installs headless Chromium and its system libraries for browser page checks (PAGE_RENDERS).
ARG PAGE_RENDER=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN if [ "$PAGE_RENDER" = "true" ]; then npx playwright install --with-deps --only-shell chromium; fi
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY migrations ./migrations
COPY data ./data
RUN npm run build
USER node
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["npm","run","start"]
