# Node + Chrome (Chrome for Testing) for Selenium on Railway
# Explicit platform for Railway (linux/amd64)
FROM --platform=linux/amd64 node:20-bookworm

# Chrome for Testing: matching Chrome + ChromeDriver (no version mismatch)
# Install deps Chrome/Chromedriver need (status 127 = missing libs)
ARG CHROME_VERSION=145.0.7632.26
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    wget \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    fonts-liberation \
    && wget -q "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" -O /tmp/chrome.zip \
    && unzip -o /tmp/chrome.zip -d /tmp \
    && mv /tmp/chrome-linux64/chrome /usr/local/bin/ \
    && chmod +x /usr/local/bin/chrome \
    && wget -q "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chromedriver-linux64.zip" -O /tmp/chromedriver.zip \
    && unzip -o /tmp/chromedriver.zip -d /tmp \
    && mv /tmp/chromedriver-linux64/chromedriver /usr/local/bin/ \
    && chmod +x /usr/local/bin/chromedriver \
    && rm -rf /var/lib/apt/lists/* /tmp/chrome.zip /tmp/chromedriver.zip /tmp/chrome-linux64 /tmp/chromedriver-linux64

ENV CHROME_BIN=/usr/local/bin/chrome
ENV CHROMEDRIVER_PATH=/usr/local/bin/chromedriver
ENV PATH="/usr/local/bin:${PATH}"

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
