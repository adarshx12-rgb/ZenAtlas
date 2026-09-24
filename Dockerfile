FROM node:24.20.0-bookworm-slim
# true installs headless Chromium and its system libraries for browser page checks (PAGE_RENDERS).
ARG PAGE_RENDER=false
# true installs LibreOffice (about 400 MB) so the Docs tab can preview Word, PowerPoint and Excel files; set DOC_PREVIEW_CONVERTER=soffice.
ARG DOC_PREVIEW=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
RUN if [ "$PAGE_RENDER" = "true" ]; then npx playwright install --with-deps --only-shell chromium; fi
RUN if [ "$DOC_PREVIEW" = "true" ]; then apt-get update && apt-get install -y --no-install-recommends     libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui && rm -rf /var/lib/apt/lists/*; fi
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
